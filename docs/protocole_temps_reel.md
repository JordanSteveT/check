# Protocole temps réel & machine à états — Check

Ce document définit **tous les messages** échangés entre l'application web et le serveur (Cloudflare), ainsi que les **états** d'un salon et d'une partie. Les types TypeScript et les schémas Zod du paquet `packages/protocol` doivent correspondre exactement à ce document.

> **Version 1.0 — 19/11/2026.** Références : règles (`cahier_des_charges_check_v2.md`), jetons (`specification_comptes_et_jetons.md`), architecture (`architecture_technique.md`).
>
> **Version 1.1 — 19/11/2026.** Suppression de la victoire suspendue en duel (champ `pendingDuelWinnerId` et événement `DUEL_WIN_PENDING` retirés) : poser sa dernière carte termine la partie, sauf l'As à 2 joueurs.

---

## 1. Codage des cartes

| Élément | Code |
| ----- | ----- |
| Enseignes | `H` = Cœur ♥, `D` = Carreau ♦, `S` = Pique ♠, `C` = Trèfle ♣ |
| Valeurs | `A`, `2` … `10`, `J` (Valet), `Q` (Dame), `K` (Roi) |
| Carte | valeur + enseigne : `7H`, `10S`, `AD`, `JC` |
| Jokers | `XR` (Joker rouge), `XB` (Joker noir) |
| Couleur (rouge/noir) | `R` = H, D, XR ; `B` = S, C, XB |

Les 54 identifiants sont uniques : ils servent directement d'identifiants de cartes.

---

## 2. Connexions

| Connexion | URL | Durée de vie |
| ----- | ----- | ----- |
| Joueur (présence) | `wss://{domaine}/ws/user/{userId}` | Toute la session dans l'app |
| Salon | `wss://{domaine}/ws/room/{roomId}` | De l'entrée dans le salon à la fin de la partie |
| Liste des salons publics | `wss://{domaine}/ws/lobby` | Seulement sur l'écran « Salons publics » |

* `roomId` est l'identifiant du RoomDO créé par `newUniqueId()` (64 caractères hexadécimaux, impossible à deviner). Un identifiant mal formé ou non émis par le serveur reçoit une réponse HTTP **404** avant toute ouverture du WebSocket.
* `userId` est l'identifiant Supabase du joueur (UUID). Il figure dans l'URL parce que le Worker doit choisir le UserDO **avant** de recevoir `AUTH` ; le UserDO ferme la connexion (4001) si le `sub` du jeton ne correspond pas à `userId`.
* Une URL `/ws/…` sans en-tête `Upgrade: websocket` reçoit **426**.

### 2.1 Authentification (toutes les connexions)

1. Le client ouvre le WebSocket.
2. Premier message, dans les **5 secondes** : `{"t":"AUTH","token":"<jeton d'accès Supabase>","v":1}`.
3. Le serveur vérifie le jeton (signature via JWKS, expiration, `sub`). Réponse : `{"t":"AUTH_OK","userId":"…","serverTime":1763550000000}`.
4. Échec ou délai dépassé : fermeture avec le code **4001** (`UNAUTHORIZED`).
5. Jeton bientôt expiré : le client renvoie un `AUTH` avec le nouveau jeton (après rafraîchissement par supabase-js) sans fermer la connexion.

`v` est la version du protocole. Version non supportée : fermeture **4002** (`UPGRADE_REQUIRED`), et l'app demande un rechargement.

### 2.2 Codes de fermeture

| Code | Sens | Réaction du client |
| ----- | ----- | ----- |
| 1000 | Fin normale | Aucune |
| 4001 | Non authentifié | Rafraîchir le jeton puis reconnecter ; si échec, retour à l'écran de connexion |
| 4002 | Version obsolète | Recharger l'app |
| 4003 | Remplacé par une autre connexion du même joueur (autre onglet) | Afficher « Partie ouverte dans un autre onglet » ; ne pas reconnecter |
| 4004 | Salon inexistant ou fermé | Retour à l'accueil |
| 4008 | Trop de messages (§8) | Reconnecter après 5 s |
| 1006 / autre | Coupure réseau | Reconnexion automatique (§7) |

---

## 3. Format des messages

* Encodage **JSON**, texte UTF-8, **4 Ko maximum** par message.
* Champ `t` : type du message.
* **Client → serveur** : chaque action porte un identifiant `id` (UUID v4 généré par le client). Le serveur répond par `ACK` ou `ERROR` avec le même `id`. Un `id` déjà traité est ignoré (renvoi après reconnexion sans risque).
* **Serveur → client** : chaque événement de salon **diffusé à tous** porte `seq`, numéro croissant propre au salon, commençant à 1. Les messages privés (`AUTH_OK`, `ACK`, `ERROR`, `STATE`, `PONG`, `HAND`, `YOU_DREW`) n'ont pas de `seq`, pour ne pas créer de trou chez les autres joueurs. Un client qui constate un trou dans `seq` envoie `SYNC`.
* **Message invalide** (JSON illisible, type inconnu, champ manquant ou en trop) : `ERROR` avec le code `INVALID_MESSAGE`, et l'`id` du message s'il est lisible. Si seules les options sont invalides : `INVALID_OPTIONS` ; si seul le montant l'est : `INVALID_FEE`. Les règles métier du montant (200 à 10 000, paliers de 100) sont vérifiées par le serveur, pas par le schéma.
* Horodatages : millisecondes depuis l'époque Unix (UTC), horloge du serveur.

```json
// client → serveur
{ "t": "PLAY", "id": "3f1c…", "cards": ["7H", "7S"], "declareCheck": false }
// serveur → client (à l'émetteur)
{ "t": "ACK", "id": "3f1c…" }
// serveur → tous
{ "t": "CARDS_PLAYED", "seq": 42, "playerId": "u1", "cards": ["7H", "7S"], … }
```

---

## 4. États

### 4.1 Salon (RoomDO)

```
            créer
              │
              ▼
         ┌─────────┐  2ᵉ joueur (public)  ┌───────────┐
         │ WAITING ├─────────────────────►│ COUNTDOWN │
         └──┬───┬──┘◄─────────────────────┴─────┬─────┘
 hôte START │   │ < 2 joueurs (départs)         │ fin du compte à rebours
 ou table   │   │                               │ ou table pleine
 pleine     ▼   │ 300 s sans 2 joueurs          ▼
         ┌──────────┐                    ┌──────────┐
         │ STARTING │◄───────────────────┘          │
         └────┬─────┘                               │
  débit OK    │   débit : < 2 joueurs → WAITING     │
  (≥ 2)       ▼                                     │
         ┌──────────┐   gagnant / nulle / annulée   ┌──────────┐
         │ PLAYING  ├──────────────────────────────►│ FINISHED │──► fermé (60 s après)
         └──────────┘                               └──────────┘
         WAITING ── 300 s sans 2 joueurs ──► CLOSED
```

| État | Actions acceptées | Sortie |
| ----- | ----- | ----- |
| `WAITING` | `JOIN`, `LEAVE`, `UPDATE_OPTIONS` (hôte), `START` (hôte, salon privé, ≥ 2 joueurs) | `COUNTDOWN`, `STARTING`, `CLOSED` |
| `COUNTDOWN` (public) | `JOIN`, `LEAVE` | `STARTING` à la fin ; retour `WAITING` si < 2 joueurs |
| `STARTING` | Aucune (les messages reçoivent `ERROR ROOM_STARTING`) | `PLAYING` ou `WAITING` |
| `PLAYING` | `PLAY`, `DRAW`, `CALL_CHECK`, `LEAVE` (= abandon), `SYNC` | `FINISHED` |
| `FINISHED` | `SYNC`, `LEAVE` | `CLOSED` après 60 s |
| `CLOSED` | Aucune | Les connexions sont fermées avec le code 4004 |

**Précisions (SRV-04) :**

* Un salon qui n'a pas été créé par `POST /api/rooms` (ou qui est `CLOSED`) ferme toute nouvelle connexion avec le code **4004**.
* Le rôle d'hôte passe au joueur arrivé le plus tôt quand l'hôte quitte le salon, **privé ou public** (règles §2.1.5 ; dans un salon public, l'hôte sert seulement à `UPDATE_OPTIONS`).
* `START` dans un salon public : `ERROR NOT_HOST` (pas de lancement manuel). `UPDATE_OPTIONS` hors de `WAITING` : `ROOM_LOCKED` (`ROOM_STARTING` pendant `STARTING`). Une action de jeu (`PLAY`, `DRAW`, `CALL_CHECK`) hors de `PLAYING` : `NOT_YOUR_TURN`.
* Un joueur dont la connexion se coupe en salle d'attente **reste assis** (affiché déconnecté) ; il quitte le salon seulement avec `LEAVE`.
* Durée de vie : 300 s après la création, un salon `WAITING` de moins de 2 joueurs est fermé ; passé ce délai, il est fermé dès qu'il redescend sous 2 joueurs en `WAITING`.
* `STARTING` → `WAITING` (moins de 2 joueurs débités) : chaque joueur restant reçoit un `STATE` à jour (aucun événement dédié).
* L'arrivée de chaque joueur est un événement numéroté (`PLAYER_JOINED`), même s'il est seul : le `STATE` reçu après `JOIN` porte le `seq` de son propre `PLAYER_JOINED`, qui ne lui est pas renvoyé.

### 4.2 Partie (état du moteur)

| Champ | Type | Sens |
| ----- | ----- | ----- |
| `gameId` | UUID | Identifiant de la partie (aussi utilisé dans Supabase) |
| `seats` | liste ordonnée de `playerId` | Ordre horaire |
| `hands` | `playerId → carte[]` | **Jamais envoyé tel quel** (voir vue joueur §5) |
| `deck` | carte[] | Pioche, jamais envoyée |
| `discard` | carte[] | Talon ; le dernier élément est la carte visible |
| `currentPlayerId` | texte | Joueur dont c'est le tour |
| `turnDeadline` | horodatage | Fin du tour |
| `penalty` | entier ≥ 0 | Pénalité active (7 et Jokers cumulés) |
| `requestedSuit` | `H`/`D`/`S`/`C` ou `null` | Couleur demandée par un Valet |
| `openColor` | `R`/`B` ou `null` | Couleur ouverte par un Joker |
| `checkWindow` | `{ targetId }` ou `null` | Oubli de « Check » dénonçable (règles §8) |
| `checkDeclared` | ensemble de `playerId` | Joueurs ayant annoncé « Check » et ayant encore 1 carte |
| `status` | `PLAYING` / `FINISHED` | |
| `missedTurns` | `playerId → entier` | Tours manqués consécutifs (forfait à 3) |
| `connected` | `playerId → booléen` | |
| `forfeited` | ensemble de `playerId` | Joueurs sortis (abandon ou forfait) |
| `roundsWithoutPlay` | entier | Pour la règle de blocage (règles §7.4) |

---

## 5. Vue envoyée à chaque joueur (anti-triche)

Objet `PlayerView`, construit par le RoomDO à partir de la vue du moteur `getPlayerView(state, playerId)` (champs `players` sans `pseudo`, `me` et `game` sans `pot`), complétée par les champs du salon (`roomId`, `pseudo`, `fee`, `pot`, `seq`…) :

```ts
type PlayerView = {
  roomId: string; roomStatus: RoomStatus; roomType: "PRIVATE" | "PUBLIC"; code?: string; // code seulement pour un salon privé
  hostId: string; fee: number; options: RoomOptions; // R1 à R8
  players: { id: string; pseudo: string; seat: number; handCount: number;
             connected: boolean; checkDeclared: boolean; forfeited: boolean }[];
  me: { id: string; hand: Card[] };            // SA main uniquement
  game?: {
    gameId: string; pot: number; topCard: Card; deckCount: number;
    currentPlayerId: string; turnDeadline: number;
    penalty: number; requestedSuit: Suit | null; openColor: "R" | "B" | null;
    checkWindowTargetId: string | null;
    legal: { playable: Card[]; canDraw: boolean; mustChooseSuit: boolean }; // calculé pour « me »
  };
  seq: number; serverTime: number;
};
```

---

## 6. Messages

### 6.1 Client → serveur (connexion salon)

| Message | Champs | Quand | Erreurs possibles |
| ----- | ----- | ----- | ----- |
| `AUTH` | `token`, `v` | Premier message | Fermeture 4001 / 4002 |
| `JOIN` | `id` | Après `AUTH_OK` | `ROOM_FULL`, `ROOM_LOCKED`, `ALREADY_IN_ROOM`, `INSUFFICIENT_BALANCE`, `GUEST_NOT_ALLOWED`, `EMAIL_NOT_VERIFIED` |
| `LEAVE` | `id` | Tout état ; en `PLAYING` = abandon (confirmation demandée côté app) | — |
| `UPDATE_OPTIONS` | `id`, `options`, `fee` | Hôte, état `WAITING` | `NOT_HOST`, `INVALID_FEE`, `INVALID_OPTIONS`, `INSUFFICIENT_BALANCE` (si l'hôte ne peut pas payer) |
| `START` | `id` | Hôte, salon privé, `WAITING`, ≥ 2 joueurs | `NOT_HOST`, `NOT_ENOUGH_PLAYERS` |
| `PLAY` | `id`, `cards` (liste **ordonnée**, la dernière devient visible), `suit?` (obligatoire si un Valet est posé et R2 actif), `declareCheck?` | Son tour | `NOT_YOUR_TURN`, `CARD_NOT_IN_HAND`, `ILLEGAL_PLAY`, `INVALID_COMBO`, `SUIT_REQUIRED`, `MUST_COUNTER_OR_DRAW`, `ACE_FINISH_FORBIDDEN` |
| `DRAW` | `id` | Son tour (sans pénalité : 1 carte ; avec pénalité : toute la pénalité) | `NOT_YOUR_TURN` |
| `CALL_CHECK` | `id`, `targetId` | Pendant la fenêtre d'oubli (règles §8) | `NO_CHECK_TO_CALL` |
| `SYNC` | `id` | Trou dans `seq`, retour au premier plan, doute | — |
| `PING` | `c` (horodatage client) | Toutes les **15 s** | — |

### 6.2 Serveur → client (connexion salon)

Les événements marqués « privé » ne sont envoyés qu'au joueur concerné.

| Message | Champs principaux | Diffusion |
| ----- | ----- | ----- |
| `AUTH_OK` | `userId`, `serverTime` | Privé |
| `ACK` / `ERROR` | `id` ; `code`, `message` pour `ERROR` | Privé |
| `STATE` | `view: PlayerView` | Privé (après `JOIN`, `SYNC`, reconnexion) |
| `PONG` | `c` (renvoyé), `s` (horloge serveur) | Privé |
| `PLAYER_JOINED` | `player` | Tous |
| `PLAYER_LEFT` | `playerId`, `reason` (`LEFT`, `KICKED_BALANCE`) | Tous |
| `HOST_CHANGED` | `hostId` | Tous |
| `OPTIONS_UPDATED` | `options`, `fee` | Tous |
| `COUNTDOWN_STARTED` / `COUNTDOWN_CANCELLED` | `endsAt` | Tous |
| `GAME_STARTING` | — (affiche « Distribution… ») | Tous |
| `GAME_STARTED` | `gameId`, `pot`, `seats`, `starterCard`, `currentPlayerId`, `turnDeadline`, `handCounts` | Tous |
| `HAND` | `cards` | Privé (début de partie) |
| `CARDS_PLAYED` | `playerId`, `cards`, `topCard`, `requestedSuit`, `openColor`, `penalty`, `skipped` (joueurs sautés par des As), `handCount`, `checkDeclared`, `nextPlayerId`, `turnDeadline` | Tous |
| `CARDS_DRAWN` | `playerId`, `count`, `reason` (`NORMAL`, `PENALTY`, `CHECK_PENALTY`, `TIMEOUT`), `handCount`, `deckCount`, `nextPlayerId`, `turnDeadline` | Tous |
| `YOU_DREW` | `cards` | Privé |
| `DECK_RESHUFFLED` | `deckCount` | Tous |
| `CHECK_WINDOW` | `targetId` (a oublié d'annoncer), ou `null` à la fermeture | Tous |
| `CHECK_CALLED` | `callerId`, `targetId`, `penalty` (2) | Tous |
| `PLAYER_CONNECTION` | `playerId`, `connected` | Tous |
| `PLAYER_FORFEIT` | `playerId`, `reason` (`LEFT`, `TIMEOUTS`, `DISCONNECTED`), `nextPlayerId`, `turnDeadline` (`null` si la partie est finie) | Tous |
| `GAME_OVER` | `result` (`WIN`, `DRAW`, `ABORTED`), `winnerId`, `reason` (`EMPTY_HAND`, `LAST_PLAYER`, `BLOCKED`, `TECHNICAL`), `pot`, `commission`, `payout`, `hands` (mains restantes révélées) | Tous |

### 6.3 Connexion joueur (`/ws/user/{userId}`)

| Sens | Message | Rôle |
| ----- | ----- | ----- |
| C → S | `AUTH`, `PING` | Comme ci-dessus |
| S → C | `CURRENT_ROOM` `{ roomId \| null }` | À la connexion : permet de revenir dans une partie en cours après un rechargement |
| S → C | `GUEST_EXPIRING` `{ secondsLeft }` | Invité reconnecté pendant le délai de 5 min |

### 6.4 Connexion liste (`/ws/lobby`)

| Sens | Message | Rôle |
| ----- | ----- | ----- |
| C → S | `AUTH`, `PING`, `QUICK_PLAY { id, fee }` | Partie rapide : le serveur choisit un salon public en attente au même montant, ou en crée un |
| S → C | `LOBBY_SNAPSHOT { rooms }` | Liste complète à la connexion |
| S → C | `LOBBY_ROOM_UPSERT { room }` / `LOBBY_ROOM_REMOVED { roomId }` | Mises à jour |
| S → C | `QUICK_PLAY_MATCHED { roomId }` | Le client ouvre alors `/ws/room/{roomId}` |

`room` = `{ roomId, fee, options, playerCount, maxPlayers, status, countdownEndsAt }`.

### 6.5 Requêtes HTTP du Worker

| Route | Corps | Réponse | Erreurs |
| ----- | ----- | ----- | ----- |
| `POST /api/rooms` | `type`, `fee`, `options` | `roomId`, `code` (privé) | `INSUFFICIENT_BALANCE`, `INVALID_FEE`, `INVALID_OPTIONS`, `GUEST_NOT_ALLOWED`, `EMAIL_NOT_VERIFIED`, `ALREADY_IN_ROOM` |
| `GET /api/rooms/by-code/{code}` | — | `roomId` | `ROOM_NOT_FOUND` |
| `POST /api/guest/logout` | — | `ok` (expire l'invité immédiatement) | `IN_GAME` |
| `DELETE /api/account` | `confirm: true` | `ok` | `IN_GAME` |
| `POST /api/client-errors` | `message`, `stack`, `context` | `ok` | `RATE_LIMITED` |

Toutes exigent l'en-tête `Authorization: Bearer <jeton Supabase>`. Les opérations sur le solde et les bonus passent par Supabase directement (spécification des jetons §11).

---

## 7. Reconnexion

1. Fermeture inattendue → nouvel essai après **0,5 s, 1 s, 2 s, 4 s**, puis toutes les **5 s**.
2. L'app affiche un bandeau « Reconnexion… » dès la première seconde de coupure.
3. À la reconnexion : `AUTH`, puis le serveur envoie directement `STATE` si le joueur est toujours dans le salon.
4. Les actions envoyées pendant la coupure ne sont **pas** mises en file : l'app désactive les boutons de jeu tant que la connexion n'est pas rétablie.
5. Côté serveur, la déconnexion déclenche les règles du cahier des charges §9 (délai de grâce de 60 s pendant son tour, puis actions automatiques, forfait après 3 tours manqués).
6. **Un seul WebSocket par joueur et par salon** : une nouvelle connexion du même joueur ferme l'ancienne (code 4003).

**Précisions (SRV-08) :**

* Après `AUTH`, un joueur **assis** dans le salon reçoit directement `STATE` (sans `JOIN`). En partie, le moteur le note reconnecté ; les autres joueurs reçoivent `PLAYER_CONNECTION` (`connected: true`). À la fermeture de sa dernière connexion, ils reçoivent `PLAYER_CONNECTION` (`connected: false`), en salle d'attente comme en partie.
* La règle « une seule connexion » (4003) s'applique aux connexions **salon**. Le remplacement d'une connexion par une autre du même joueur ne produit pas de `PLAYER_CONNECTION`.
* **Identifiant déjà traité :** le serveur garde les 200 dernières réponses du salon. Un `id` renvoyé reçoit la **même** réponse (`ACK` ou `ERROR` avec le même code), sans que l'action soit rejouée. `JOIN` et `SYNC` en sont exclus : ils renvoient toujours l'état à jour.

**Persistance du salon (SRV-07) :** l'état du salon (salle d'attente, partie, `seq`) est enregistré dans le stockage du RoomDO **avant** l'envoi de tout message qui en découle (`ACK`, événements, `STATE`). Un redémarrage du RoomDO ne perd donc aucun coup qu'un joueur a vu : le nouvel exemplaire relit l'état, l'alarme reste armée, et les joueurs qui se reconnectent reçoivent la partie sauvegardée avec `JOIN` (ou `SYNC`).

---

## 8. Limites

| Limite | Valeur | Dépassement |
| ----- | ----- | ----- |
| Messages par connexion | 20 par seconde | `ERROR RATE_LIMITED` (le message n'est pas traité) ; à la 3ᵉ seconde où la limite est dépassée, fermeture 4008 |
| Taille d'un message | 4 Ko | Fermeture 4008 |
| `CALL_CHECK` par joueur | 1 par fenêtre d'oubli | `ERROR NO_CHECK_TO_CALL` |
| Créations de salon | 10 par heure et par joueur | `ERROR RATE_LIMITED` |

---

## 9. Chronomètres côté serveur (alarmes du RoomDO)

Un Durable Object n'a qu'**une alarme** : le RoomDO garde une liste d'échéances et programme toujours la plus proche.

| Échéance | Durée | Effet |
| ----- | ----- | ----- |
| Vie du salon en attente | 300 s après création | `CLOSED` si < 2 joueurs |
| Compte à rebours public | 60 s après le 2ᵉ joueur | Passage à `STARTING` |
| Tour | 30 s (60 s au total si le joueur est déconnecté pendant son tour) | Action automatique (règles §7.3) |
| Partie trop longue | 2 h après le lancement | `refund_game` (`ABORTED`, `TECHNICAL`) |
| Fermeture après la fin | 60 s après `FINISHED` | `CLOSED` |

Le gestionnaire d'alarme est **idempotent** : il relit l'heure et l'état, et ne fait rien si l'échéance a déjà été traitée.

**Précisions (SRV-06) :**

* L'alarme traite, dans l'ordre chronologique, **toutes** les échéances dues (par exemple plusieurs joueurs déconnectés à la suite), dans la limite de 50 par déclenchement, puis se réarme sur la suivante. Une alarme en retard ne joue qu'une action automatique pour le joueur courant : le tour suivant part de l'heure de traitement.
* La vie du salon en attente n'est une échéance que tant qu'il compte moins de 2 joueurs.
* Partie trop longue : `GAME_OVER` avec `result: ABORTED`, `reason: TECHNICAL`, `winnerId: null`, commission et gain à 0, puis `refund_game` pour tous les joueurs débités.
* Durées : clés `timers.*` de `game_config.ts` (règles §11.3).

---

## 10. Horloge

* Chaque `PONG` donne `s` (heure serveur). Le client calcule `rtt = maintenant − c` et `décalage = s + rtt/2 − maintenant`. Il garde la **médiane des 5 dernières mesures**.
* Temps restant affiché = `turnDeadline − (maintenant + décalage)`.
* La latence mesurée (`rtt`) est affichée discrètement (icône de signal : vert < 150 ms, orange < 400 ms, rouge au-delà).

---

## 11. Codes d'erreur du jeu

| Code | Message affiché |
| ----- | ----- |
| `NOT_YOUR_TURN` | « Ce n'est pas votre tour. » |
| `CARD_NOT_IN_HAND` | « Carte introuvable dans votre main. » (resynchronisation automatique) |
| `ILLEGAL_PLAY` | « Cette carte ne peut pas être posée. » |
| `INVALID_COMBO` | « Ces cartes ne peuvent pas être posées ensemble. » |
| `SUIT_REQUIRED` | « Choisissez une couleur. » |
| `MUST_COUNTER_OR_DRAW` | « Contrez avec un 7 ou un Joker, ou piochez la pénalité. » |
| `ACE_FINISH_FORBIDDEN` | « À deux joueurs, on ne peut pas finir sur un As. » |
| `NO_CHECK_TO_CALL` | « Rien à dénoncer. » |
| `ROOM_FULL` / `ROOM_LOCKED` / `ROOM_NOT_FOUND` / `ROOM_STARTING` | « Salon complet. » / « Partie déjà commencée. » / « Salon introuvable. » / « La partie démarre… » |
| `NOT_HOST` / `NOT_ENOUGH_PLAYERS` | « Seul l'hôte peut faire ça. » / « Il faut au moins 2 joueurs. » |
| `INVALID_OPTIONS` | « Options de partie invalides. » |
| `INVALID_MESSAGE` | « Une erreur est survenue. Rechargez l'application. » (message mal formé ; signe d'une app obsolète) |
| `RATE_LIMITED` | « Trop d'actions, patientez un instant. » |

Les codes liés aux comptes et aux jetons sont ceux de la spécification des jetons (§11.3).

---

## 12. Interface du moteur (`packages/engine`)

Fonctions pures, sans effet de bord, utilisées par le RoomDO **et** par l'app (pour l'aperçu des coups jouables).

| Fonction | Rôle |
| ----- | ----- |
| `createGame(config, options, players, rng, now, gameId)` | Mélange, distribue 5 cartes, tire la carte de départ (règles B5), tire le premier joueur. `players` dans l'ordre horaire ; `now` fixe `turnDeadline` ; `gameId` est choisi par le serveur (le moteur ne génère pas d'identifiant). Renvoie l'état ; les événements `GAME_STARTED` (avec `pot`) et `HAND` sont construits par le RoomDO |
| `getLegalMoves(state, playerId)` | `{ playable, canDraw, mustChooseSuit }` : cartes jouables seules ou en première carte d'une combinaison (l'As qui viderait la main en duel en est exclu), pioche possible, choix de couleur requis. Les combinaisons ne sont pas énumérées : une sélection de plusieurs cartes se vérifie avec `checkPlay` |
| `checkPlay(state, playerId, { cards, suit?, declareCheck? })` | Code d'erreur que lèverait `applyPlay`, ou `null` si le coup est accepté (aperçu côté app) |
| `applyPlay(state, playerId, { cards, suit?, declareCheck? }, rng, now)` | Applique un coup (`rng` : pioche de la pénalité d'oubli du « Check » en mode `automatic`) ; renvoie `{ state, events }` ou lève `EngineError(code)`. Les champs optionnels sont regroupés dans un objet (le message `PLAY` sans `t` ni `id`) |
| `canPlayCard(state, card)` | La carte peut-elle être posée seule (ou en première carte d'une combinaison) ? Utilisée par `getLegalMoves` et par l'app |
| `applyDraw(state, playerId, rng, now)` | Pioche simple ou encaissement de la pénalité. `rng` sert au remélange du talon si la pioche est vide (règles §7.4) |
| `applyCheckCall(state, callerId, targetId, rng)` | Dénonciation de l'oubli de « Check » ; le fautif pioche 2 cartes (`rng` en cas de remélange), le tour ne change pas |
| `applyTimeout(state, rng, now)` | Action automatique du joueur courant (pioche, puis forfait au 3ᵉ tour manqué). Ne fait rien si `now < turnDeadline` ou si la partie est finie : l'alarme peut l'appeler plusieurs fois sans risque |
| `applyForfeit(state, playerId, reason, now)` | Abandon ou forfait ; `now` fixe l'échéance du joueur suivant si c'était le tour du sortant. Sans effet sur un joueur déjà sorti |
| `setConnected(state, playerId, connected, now)` | Connexion/déconnexion (prolonge le tour à 60 s au total si le joueur se déconnecte pendant son tour, avant l'échéance) |
| `getPlayerView(state, playerId)` | Vue filtrée (§5) : `players` (sans pseudo), `me.hand`, `game` (avec `status` et `legal`). Ne contient jamais la pioche ni les mains adverses |

`events` est la liste des messages du §6.2 à diffuser, sans `seq` (ajouté par le RoomDO). Le générateur aléatoire `rng` est injecté : une fonction qui renvoie un nombre dans [0, 1), construite sur `crypto.getRandomValues` en production, générateur à graine fixe dans les tests.

`config` (type `EngineConfig`) est construit par le Worker à partir de `game_config.ts` ; le moteur n'a pas de valeurs par défaut. L'état du moteur ne contient que du JSON (pas de `Set` ni de `Map`) pour être sauvegardé tel quel par le RoomDO ; la pioche a son dessus en `deck[0]`.

> **Version 1.8 — 22/11/2026.** SRV-08 : reconnexion, connexion remplacée, identifiants déjà traités, limite de débit (§7, §8).
>
> **Version 1.7 — 20/11/2026.** SRV-07 : persistance du salon avant tout envoi (§7).
>
> **Version 1.6 — 20/11/2026.** SRV-06 : précisions sur le gestionnaire d'échéances (§9).
>
> **Version 1.5 — 20/11/2026.** SRV-04 : précisions sur la salle d'attente (§4.1).
>
> **Version 1.4 — 19/11/2026.** SRV-02 : `/ws/user/{userId}` ; format de `roomId` ; réponses 404 et 426 (§2).
>
> **Version 1.3 — 19/11/2026.** SRV-01 : `seq` réservé aux événements diffusés ; code `INVALID_MESSAGE` (§3, §11).
>
> **Version 1.2 — 19/11/2026.** `createGame` reçoit `now` et `gameId` (ENG-02). `applyPlay` reçoit `{ cards, suit?, declareCheck? }` ; ajout de `canPlayCard` (ENG-03). Dans `CARDS_PLAYED`, `nextPlayerId` et `turnDeadline` valent `null` quand le coup termine la partie. `applyDraw` reçoit `rng` (ENG-06) ; les événements privés du moteur (`YOU_DREW`) portent `playerId`, le destinataire, que le RoomDO retire avant l'envoi. `applyPlay` et `applyCheckCall` reçoivent `rng` (ENG-07). Toute pose ou pioche ferme la fenêtre de dénonciation ouverte et émet `CHECK_WINDOW` avec `targetId: null` avant ses propres événements. `applyTimeout` reçoit `rng`, `applyForfeit` reçoit `now`, `PLAYER_FORFEIT` porte `nextPlayerId` et `turnDeadline` (ENG-09). Ajout de `checkPlay` ; `getPlayerView` ne renvoie que la partie moteur de la vue (ENG-10).

**Joueur déconnecté dont le tour arrive :** le moteur fixe `turnDeadline = now` (tour déjà échu). Le RoomDO programme alors son alarme immédiatement et appelle `applyTimeout` : c'est l'action automatique « immédiate » des règles §9.

**Blocage (règles §7.4.3) :** `roundsWithoutPlay` compte les tours consécutifs **commencés** alors que la pioche est vide et que le talon ne contient que la carte visible, et terminés sans pose. Il revient à 0 à chaque pose ou dès qu'un tour commence avec des cartes disponibles. Quand il atteint le nombre de joueurs actifs, la partie s'arrête (`BLOCKED`).
