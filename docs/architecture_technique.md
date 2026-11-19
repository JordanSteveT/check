# Architecture technique — Check (application web)

Ce document fixe **comment** le jeu est construit. Les règles du jeu sont dans `cahier_des_charges_check_v2.md`, les comptes et les jetons dans `specification_comptes_et_jetons.md`, les messages temps réel dans `protocole_temps_reel.md`, la base de données dans `schema_supabase.sql`.

> **Version 1.0 — 19/11/2026.** Contraintes du porteur du projet : application **web**, développée **de zéro**, hébergée sur **Cloudflare**, base de données **Supabase**, temps réel **sans latence perceptible**.

---

## 1. Choix techniques (figés)

| Domaine | Choix | Raison |
| ----- | ----- | ----- |
| Langage | **TypeScript** partout (client, serveur, moteur) | Un seul langage ; le moteur de règles est partagé entre serveur et navigateur |
| Application web | **React 19 + Vite**, application monopage (SPA) installable (**PWA**) | Léger, rapide sur Android d'entrée de gamme, installable sur l'écran d'accueil sans store |
| État côté client | **Zustand** | Simple, sans boilerplate |
| Styles | **CSS Modules** + variables CSS ; animations CSS (`transform`, `opacity`) | Pas de dépendance lourde ; animations fluides sur mobile |
| Hébergement du site | **Cloudflare Workers – fichiers statiques** (*static assets*) | Même domaine que l'API et les WebSockets : pas de CORS, un seul déploiement |
| Serveur de jeu temps réel | **Cloudflare Durable Objects** avec **WebSockets en hibernation** | Un objet par salon, état en mémoire, au plus près des joueurs |
| Base de données | **Supabase Postgres** (région **Paris `eu-west-3`**) | Demandé ; Paris est la région Supabase la plus proche du Cameroun (aucune région en Afrique) |
| Authentification | **Supabase Auth** : Google, email + mot de passe, **connexion anonyme** (invités) | Couvre exactement les 3 types de comptes ; conversion invité → compte native |
| Anti-robots | **Cloudflare Turnstile** (intégré à Supabase Auth) | Protège inscription, connexion et création d'invités |
| Emails | **SMTP personnalisé** branché sur Supabase Auth (ex. Resend, Brevo) | L'envoi par défaut de Supabase n'est pas fait pour la production |
| Validation des messages | **Zod** (schémas partagés client/serveur) | Un message invalide est rejeté avant d'atteindre le moteur |
| Tests | **Vitest** (moteur, serveur), **@cloudflare/vitest-pool-workers** (Durable Objects), **Playwright** (bout en bout) | Standard de l'écosystème |
| Gestion du dépôt | **pnpm** en monorepo | Partage du moteur et du protocole |
| CI/CD | **GitHub Actions** + **Wrangler** + **Supabase CLI** | Déploiement automatique à chaque fusion |

---

## 2. Vue d'ensemble

```
                         ┌────────────────────────────────────────────┐
  Navigateur (PWA)       │            Cloudflare (même domaine)        │
 ┌──────────────────┐    │                                            │
 │ React + Zustand  │HTTPS│  Worker « check »                          │
 │ moteur partagé   ├────►  ├─ fichiers statiques (le site)           │
 │ (aperçu des coups│    │  ├─ /api/*  (HTTP : salons, invité…)       │
 │  jouables)       │ WS │  └─ /ws/*   (WebSockets) ──┐                │
 │                  ├────►                          ▼                │
 └──────┬───────────┘    │   ┌──────────────┐ ┌──────────────┐ ┌────────────┐
        │                │   │ RoomDO       │ │ LobbyDO      │ │ UserDO     │
        │                │   │ 1 par salon  │ │ 1 global     │ │ 1 par joueur│
        │                │   │ partie en    │ │ salons publics│ │ présence,  │
        │                │   │ mémoire      │ │ matchmaking  │ │ salon actuel│
        │                │   └──────┬───────┘ └──────────────┘ └─────┬──────┘
        │                └──────────┼───────────────────────────────┼───────┘
        │  supabase-js              │ RPC (clé secrète)             │
        │  (Auth, solde, historique,│ uniquement au lancement       │
        │   bonus du jour, Realtime │ et à la fin d'une partie      │
        │   sur son portefeuille)   ▼                               ▼
        │                ┌──────────────────────────────────────────────┐
        └───────────────►│ Supabase (Paris) : Auth · Postgres · Realtime │
                         └──────────────────────────────────────────────┘
```

### 2.1 Composants

| Composant | Rôle | Ce qu'il ne fait pas |
| ----- | ----- | ----- |
| **Application web** | Affichage, animations, saisie. Utilise le moteur partagé pour **griser les cartes injouables** et **animer immédiatement** un coup avant la confirmation du serveur | Ne décide jamais de la légalité d'un coup ni d'un solde |
| **Worker** (point d'entrée) | Sert le site, route `/api/*` et `/ws/*`, vérifie le jeton Supabase (JWT) sur les requêtes HTTP | Ne garde aucun état |
| **RoomDO** | Un objet par salon : salle d'attente, options, partie, chronomètres (alarmes), diffusion des événements. Sauvegarde l'état dans son stockage SQLite après chaque coup | Ne parle à Supabase qu'au **lancement** (débit des frais) et à la **fin** (gain ou remboursement) |
| **LobbyDO** | Liste des salons publics en temps réel, partie rapide (matchmaking) | Ne gère aucune partie |
| **UserDO** | Un objet par joueur : présence (connecté ou non), **salon actuel** (un seul à la fois), expiration des invités après 5 min de déconnexion | — |
| **Supabase Auth** | Comptes Google, email, invités ; vérification d'email ; mot de passe oublié ; conversion invité → compte | — |
| **Supabase Postgres** | Profils, portefeuilles, journal des jetons, historique des parties. Toutes les opérations sur les jetons sont des **fonctions SQL atomiques** | Aucune donnée de partie en cours |
| **Supabase Realtime** | Notifie le navigateur quand **son** solde change | Aucun usage pour le jeu lui-même |

---

## 3. Temps réel sans latence : les 6 règles

1. **Aucune base de données sur le chemin d'un coup.** Un coup va du navigateur au RoomDO et revient. Le RoomDO valide avec le moteur en mémoire (< 5 ms) et diffuse. Supabase n'intervient qu'au début et à la fin de la partie.
2. **Connexion WebSocket directe au salon.** Le navigateur se connecte au RoomDO de son salon, sans intermédiaire.
3. **Retour visuel immédiat (optimiste).** Le navigateur connaît les cartes jouables grâce au moteur partagé. Au clic, la carte part aussitôt vers le talon (animation de 250 ms). La confirmation du serveur arrive pendant l'animation. En cas de refus (rare), la carte revient dans la main avec un message.
4. **Messages petits et incrémentaux.** Le serveur envoie l'événement (« X a posé 7♥ »), pas l'état complet. L'état complet n'est envoyé qu'à la connexion, à la reconnexion ou sur demande (`SYNC`).
5. **Horloge synchronisée.** Les chronomètres sont calculés par le serveur ; le navigateur corrige l'écart d'horloge grâce aux `PING`/`PONG` (protocole §6).
6. **Reconnexion transparente.** Coupure réseau → reconnexion automatique, puis l'état complet est renvoyé. Le joueur garde sa place pendant le délai de grâce (cahier des charges §9).

### 3.1 Où se trouvent les serveurs

| Élément | Emplacement | Remarque |
| ----- | ----- | ----- |
| Site et Worker | Réseau Cloudflare, au plus près de chaque joueur | Cloudflare dispose d'un point de présence au Cameroun |
| RoomDO | Créé **près du premier joueur** qui ouvre le salon (comportement par défaut) | Les Durable Objects ne tournent pas dans tous les centres de données. Mesurer en préproduction l'option `locationHint: "afr"` contre le comportement par défaut, puis figer le meilleur réglage dans `game_config` |
| Supabase | Paris (`eu-west-3`) | Mesurer Paris, Francfort et Londres depuis Douala et Yaoundé avant de créer le projet de production ; garder la plus rapide |

### 3.2 Budget de latence (objectifs à tenir en bêta)

| Mesure | Objectif |
| ----- | ----- |
| Retour visuel après un clic sur une carte | **< 16 ms** (animation locale) |
| Confirmation d'un coup par le serveur (aller-retour WebSocket), médiane au Cameroun | **< 150 ms** |
| Même mesure, 95ᵉ centile | **< 400 ms** |
| Lancement d'une partie (débit des frais dans Supabase compris) | **< 1,5 s** |
| Premier affichage du site en 3G | **< 3 s** ; JavaScript initial **< 200 Ko** compressés |

---

## 4. Flux principaux

### 4.1 Connexion d'un joueur

1. L'app se connecte avec Supabase Auth (Google, email ou invité), Turnstile à l'appui.
2. Elle appelle la fonction SQL `sync_account(pseudo, device_id)` : création du profil, du portefeuille, attribution des bonus selon les règles (spécification des jetons §9).
3. Elle ouvre le WebSocket `/ws/user` (UserDO) : présence et salon en cours.
4. Elle s'abonne en Realtime à **sa** ligne de la table `wallets` pour afficher le solde en direct.

### 4.2 Créer et rejoindre un salon

1. `POST /api/rooms` (type, frais, options). Le Worker vérifie le jeton, appelle `check_can_join` dans Supabase (statut, invité, solde ≥ frais), crée l'identifiant du salon et initialise le RoomDO. Salon public : il l'inscrit dans le LobbyDO.
2. L'app ouvre `/ws/room/{roomId}` et envoie `AUTH` puis `JOIN`.
3. Le RoomDO demande au UserDO de réserver le joueur (`claimRoom`) : refus `ALREADY_IN_ROOM` s'il est déjà ailleurs. Il revérifie l'éligibilité (`check_can_join`), puis diffuse `PLAYER_JOINED`.
4. Rejoindre par code (salon privé) : `GET /api/rooms/by-code/{code}` renvoie `roomId`, puis étape 2.

### 4.3 Lancement, partie, fin

1. Lancement (hôte, compte à rebours ou table pleine) : le RoomDO passe en `STARTING` et appelle `start_game` (débit atomique des frais). Les joueurs débités sont gardés ; les autres sont retirés.
2. Partie : tous les coups sont traités en mémoire. L'état est sauvegardé dans le stockage du RoomDO après chaque coup (écritures groupées, sans attente).
3. Fin : le RoomDO appelle `settle_game` (gain et commission) ou `refund_game` (nulle ou annulée), diffuse `GAME_OVER`, libère les joueurs dans leur UserDO. Les soldes se mettent à jour à l'écran via Realtime.
4. Si l'appel à Supabase échoue en fin de partie : 5 nouvelles tentatives (1 s, 2 s, 4 s, 8 s, 16 s). Les fonctions SQL sont **idempotentes** : rejouer un appel ne crédite jamais deux fois. Au-delà, alarme technique et nouvel essai toutes les 5 min.

### 4.4 Expiration d'un invité

1. Le UserDO voit la fermeture du dernier WebSocket de l'invité et programme une alarme à +5 min.
2. Reconnexion avant l'alarme : alarme annulée.
3. À l'alarme : si l'invité est en partie, on attend la fin de sa partie (le RoomDO prévient le UserDO). Sinon, le UserDO appelle `expire_guest` (solde brûlé, statut `EXPIRED`), puis l'API d'administration de Supabase supprime l'utilisateur.
4. Filet de sécurité : une tâche planifiée (`pg_cron`) expire chaque heure les invités sans activité depuis 24 h.

---

## 5. Sécurité

| Sujet | Règle |
| ----- | ----- |
| Clés Supabase | Clé **publishable** dans le navigateur. Clé **secrète** uniquement dans les secrets du Worker (`wrangler secret put`). Jamais dans le dépôt |
| Jetons d'accès | Le Worker et les DO vérifient la signature du JWT Supabase avec le **JWKS** du projet (clés asymétriques), en cache 10 min. Sur WebSocket, le jeton est envoyé dans le **premier message** (`AUTH`), jamais dans l'URL |
| Base de données | **RLS activé sur toutes les tables.** Le navigateur lit seulement ses propres lignes et n'écrit jamais directement : toute écriture passe par une fonction SQL |
| Anti-triche | Le serveur n'envoie à chaque joueur que les données autorisées (cahier des charges §11.2). Mélange par `crypto.getRandomValues` côté serveur |
| Abus | Turnstile sur l'authentification ; limites de débit (protocole §8) ; règles anti-abus de la spécification des jetons (§10) |
| En-têtes | `Content-Security-Policy` stricte, `Strict-Transport-Security`, cookies non utilisés (jetons en mémoire et `localStorage` géré par supabase-js) |

---

## 6. Environnements

| Environnement | Site / Worker | Supabase | Usage |
| ----- | ----- | ----- | ----- |
| **Local** | `wrangler dev` | `supabase start` (Docker) | Développement ; deux onglets = deux joueurs |
| **Préproduction** | Worker `check-staging`, sous-domaine `staging.` | Projet Supabase `check-staging` (Paris) | Tests, bêta fermée, mesures de latence |
| **Production** | Worker `check`, domaine principal | Projet Supabase `check-prod` (Paris), offre **Pro** | Joueurs |

Variables d'environnement du Worker : `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (secret), `SUPABASE_JWKS_URL`, `TURNSTILE_SITE_KEY`, `ENV` (`local`/`staging`/`production`).

---

## 7. Observabilité

* **Journaux** : Workers Logs (Cloudflare) ; chaque message porte `roomId`, `gameId`, `userId`.
* **Métriques suivies** : latence `PING`/`PONG` par pays, durée des parties, taux d'erreurs par code, taux de reconnexion, appels Supabase échoués.
* **Alertes** : échec de `settle_game` après les 5 tentatives ; solde d'un portefeuille `GAME:*` non nul plus de 10 min après la fin ; somme globale des portefeuilles ≠ 0 (contrôle quotidien).
* **Erreurs du navigateur** : remontées vers `/api/client-errors` (limité à 10 par minute et par joueur).

---

## 8. Coûts mensuels de départ

| Service | Offre | Coût indicatif |
| ----- | ----- | ----- |
| Cloudflare Workers + Durable Objects | **Workers Paid** (l'offre gratuite coupe le service quand le quota quotidien est atteint, en pleine partie) | 5 $ / mois + consommation |
| Supabase | **Pro** pour la production (l'offre gratuite met le projet en pause après 7 jours d'inactivité) ; offre gratuite possible pour la préproduction | 25 $ / mois + consommation |
| SMTP | Offre d'entrée d'un fournisseur d'emails transactionnels | 0 à 20 $ / mois |
| Nom de domaine | — | ~10 à 15 $ / an |

Tarifs à revérifier au moment de l'ouverture des comptes.

---

## 9. Structure du dépôt

```
check/
├─ packages/
│  ├─ engine/        # moteur de règles pur (aucune dépendance, aucun accès réseau)
│  │  ├─ src/        # cards.ts, deck.ts, rules.ts, state.ts, actions.ts, view.ts, errors.ts
│  │  └─ test/       # cas de test du document cas_de_test_moteur.md
│  └─ protocol/      # types des messages + schémas Zod (protocole_temps_reel.md)
├─ apps/
│  ├─ web/           # application React (PWA)
│  └─ worker/        # Worker + RoomDO + LobbyDO + UserDO ; wrangler.jsonc
├─ supabase/
│  ├─ migrations/    # 0001_init.sql = schema_supabase.sql
│  ├─ config.toml    # anonymous sign-ins, manual linking, captcha Turnstile
│  └─ seed.sql
├─ e2e/              # tests Playwright (plusieurs joueurs simulés)
└─ .github/workflows/
```

Règle d'or : **`packages/engine` ne dépend de rien** (ni React, ni Cloudflare, ni Supabase). Il reçoit un générateur aléatoire en paramètre, ce qui rend les tests reproductibles.

---

## 10. Configuration Supabase à activer

| Réglage | Valeur |
| ----- | ----- |
| Région | Paris (`eu-west-3`), sauf mesure contraire (§3.1) |
| Auth → fournisseurs | Email (confirmation obligatoire), Google, **Anonymous sign-ins** |
| Auth → liaison manuelle d'identités (*manual linking*) | **Activée** (nécessaire pour convertir un invité avec Google) |
| Auth → protection anti-robots | **Turnstile** |
| Auth → SMTP | Fournisseur personnalisé, expéditeur sur le domaine du jeu |
| Auth → URL de redirection | Domaines de production et de préproduction |
| Auth → limites de débit | Création d'invités : 30 par heure et par IP (valeur par défaut) |
| Base → extensions | `pgcrypto`, `pg_cron` |
| Realtime | Table `wallets` ajoutée à la publication `supabase_realtime` |
