# Spécification — Comptes joueurs & Économie de jetons virtuels — Check (MVP)

Ce document complète le cahier des charges du moteur de jeu (`cahier_des_charges_check_v2.md`, §2.3). Il couvre la **création de compte**, le **portefeuille de jetons**, les **frais de participation**, la **cagnotte**, la **commission** et le **bonus quotidien**.

Il est **normatif** : chaque règle est à implémenter telle quelle. Les valeurs chiffrées sont des clés de configuration (§12). Les cas de test du §14 servent de critères d'acceptation.

> **Version 1.0 — 19/11/2026.** Décisions du porteur du projet : jetons virtuels, 5 000 jetons à l'inscription, 1 000 pour un invité (perdus à la déconnexion), bonus quotidien, commission de 10 %, comptes Google, email et invité. Gains par publicité prévus après le MVP.
>
> **Version 1.1 — 19/11/2026.** Toute partie coûte **200 jetons minimum** (plus de partie gratuite). Bonus quotidien fixé à **400 jetons**.
>
> **Version 1.2 — 19/11/2026.** Adaptation à l'application web sur Cloudflare + Supabase : comptes gérés par **Supabase Auth**, données et fonctions dans `schema_supabase.sql` (qui fait foi pour le détail SQL), interfaces réparties entre Supabase et le Worker (§11).

---

## 1. Principes

| # | Principe |
| ----- | ----- |
| P1 | Les jetons sont **virtuels** : aucune valeur monétaire, **aucun achat, aucun retrait**, aucune conversion en argent. |
| P2 | **Aucun transfert** de jetons entre joueurs. Les jetons ne bougent que par les opérations listées au §5.3. |
| P3 | Les jetons sont des **entiers** (pas de décimales). |
| P4 | Le **serveur est seul maître** des soldes. Le client affiche ce que le serveur envoie et ne calcule rien. |
| P5 | Chaque mouvement de jetons est une **écriture dans un journal** (*ledger*) qu'on ne modifie ni ne supprime jamais. |
| P6 | **Un solde n'est jamais négatif.** Toute opération qui le rendrait négatif est refusée. |
| P7 | **Conservation :** pour chaque partie, les jetons entrés (frais) sont égaux aux jetons sortis (gain + commission, ou remboursements). |
| P8 | Un joueur ne peut être que dans **un seul salon à la fois** (en attente ou en partie). |

---

## 2. Types de comptes

| | **Compte Google** | **Compte Email** | **Invité** |
| ----- | ----- | ----- | ----- |
| Identifiant unique | `sub` Google (OpenID Connect) | Adresse email normalisée (minuscules, sans espaces) | Identifiant généré par le serveur |
| Vérification | Email Google considéré comme vérifié | Lien de vérification par email obligatoire | Aucune |
| Jetons de départ | **5 000** (bonus de bienvenue) | **5 000**, crédités **après vérification** de l'email | **1 000** |
| Bonus quotidien | Oui | Oui (après vérification) | **Non** |
| Salons accessibles | Tous | Tous, **après vérification** de l'email | **Salons publics uniquement** |
| Durée de vie | Permanente | Permanente | **Jusqu'à la déconnexion de la plateforme** (§4.3) |
| Conversion | — | — | Vers Google ou Email (§4.4) |

---

## 3. Données

Le schéma complet, testé, est dans **`schema_supabase.sql`** (il fait foi). Résumé :

| Table | Contenu |
| ----- | ----- |
| `auth.users` | Gérée par **Supabase Auth** (email, confirmation, `is_anonymous`, identités Google) |
| `profiles` | Un profil par utilisateur : `account_type` (`GOOGLE` / `EMAIL` / `GUEST`), `status` (`PENDING_VERIFICATION` / `ACTIVE` / `EXPIRED`), `pseudo`, `device_id`, `welcome_bonus_status` (`PENDING` / `GRANTED` / `DENIED`), `guest_bonus_granted`, `converted_at`, `last_seen_at`. Supprimé avec l'utilisateur |
| `wallets` | Un portefeuille par joueur, plus les portefeuilles système (§3.4). Solde jamais négatif pour un joueur (contrainte SQL) |
| `ledger_entries` | Journal des mouvements, **ajout seul** (un déclencheur interdit toute modification). Conservé même après suppression du compte, sans donnée personnelle |
| `games` | Une ligne par partie : frais, joueurs débités, statut, gagnant, cagnotte, commission, gain |
| `used_identities` | Hash SHA-256 des identités ayant reçu un bonus ou appartenu à un compte supprimé |
| `device_bonus_grants`, `guest_creations` | Compteurs anti-abus par appareil |
| `app_config` | Valeurs économiques (§12) |
| `ops_alerts` | Alertes techniques |

**`device_id`** : identifiant aléatoire (UUID) généré par l'app à la première visite et conservé dans le stockage du navigateur. Il change si l'utilisateur efface ses données : c'est une protection anti-abus partielle, complétée par Turnstile et les limites de Supabase.

### 3.4 Portefeuilles système

| Portefeuille | Rôle |
| ----- | ----- |
| `SYSTEM:MINT` | Source des bonus (bienvenue, invité, quotidien). Son solde devient négatif : c'est normal, il mesure les jetons créés |
| `SYSTEM:HOUSE` | Reçoit la commission de 10 % |
| `SYSTEM:BURN` | Reçoit les jetons des invités expirés et des comptes supprimés |
| `GAME:{game_id}` | Cagnotte d'une partie (séquestre). Son solde revient à 0 à la fin de la partie |

Chaque opération est une **paire d'écritures** de même montant et de signes opposés (débit d'un portefeuille, crédit d'un autre), dans la **même transaction de base de données**.

---

## 4. Création de compte, connexion, déconnexion

Toutes les connexions passent par **Supabase Auth** (bibliothèque `supabase-js` dans l'app), avec **Turnstile** (jeton `captchaToken`). Après **chaque** connexion, vérification d'email ou conversion, l'app appelle la fonction SQL **`sync_account(pseudo, device_id)`** : elle crée le profil et le portefeuille, met à jour le type et le statut, et attribue les bonus (§9). Elle est idempotente.

### 4.1 Compte Google

1. `supabase.auth.signInWithOAuth({ provider: 'google' })` → redirection Google → retour sur l'app.
2. `sync_account(null, device_id)`. Réponse `needs_pseudo: true` à la première connexion → écran du pseudo → `sync_account(pseudo, device_id)`.
3. Le compte est `ACTIVE` ; **bonus de bienvenue (5 000)** si les règles du §9 le permettent.

### 4.2 Compte Email

1. `supabase.auth.signUp({ email, password, options: { captchaToken, emailRedirectTo } })`.
   * Mot de passe : **8 caractères minimum**, au moins une lettre et un chiffre (réglage « force du mot de passe » de Supabase Auth, revérifié dans l'app).
   * Email déjà utilisé : erreur `EMAIL_TAKEN` (message renvoyé par Supabase, traduit par l'app).
2. `sync_account(pseudo, device_id)` : profil `PENDING_VERIFICATION`, solde 0. Le joueur peut se connecter mais **ne peut ni créer ni rejoindre de salon** avant la vérification. Pseudo déjà pris : `PSEUDO_TAKEN`.
3. Supabase envoie le lien de vérification (SMTP personnalisé). Renvoi : `supabase.auth.resend({ type: 'signup', email })`, au plus 1 fois par minute dans l'app.
4. Au retour du lien : `sync_account` → statut `ACTIVE`, puis **bonus de bienvenue (5 000)** si les règles du §9 le permettent.
5. Mot de passe oublié : `resetPasswordForEmail`, puis `updateUser({ password })` sur la page de retour. Le lien est à usage unique.
6. Connexion : `signInWithPassword`. La protection contre les essais répétés repose sur les **limites de débit de Supabase Auth** et sur **Turnstile**.

### 4.3 Invité

1. `supabase.auth.signInAnonymously({ options: { captchaToken } })`, puis `sync_account(null, device_id)` : profil `GUEST` `ACTIVE`, pseudo automatique **`Invite_XXXX`** (4 chiffres, unique), **1 000 jetons** (`GUEST_BONUS`). Plus de 3 invités par appareil en 24 h : `GUEST_LIMIT_REACHED` (l'app déconnecte alors la session anonyme).
2. L'app affiche en permanence un bandeau : « Compte invité : vos jetons seront perdus à la déconnexion. Créez un compte pour recevoir 5 000 jetons. »
3. **Déconnexion de la plateforme**, qui met fin au compte invité :
   * le joueur appuie sur « Se déconnecter ». L'app affiche d'abord une confirmation : « Vous allez perdre vos X jetons. Continuer ? », puis appelle `POST /api/guest/logout` ;
   * **ou** aucune connexion de l'invité au serveur depuis plus de **5 minutes** alors qu'il n'est pas en partie (onglet fermé, coupure réseau, données du navigateur effacées). C'est le **UserDO** (Cloudflare) qui le détecte (architecture §4.4).
4. **Pendant une partie**, la perte de connexion suit les règles du moteur (cahier des charges §9 : délai de grâce, puis forfait). Le compte invité n'expire qu'**une fois sa partie terminée**. Si un gain lui revient alors qu'il est toujours déconnecté, il est crédité puis perdu avec le reste.
5. **À l'expiration :** fonction `expire_guest` (écriture `GUEST_EXPIRY` qui vide le solde vers `SYSTEM:BURN`, statut `EXPIRED`), puis suppression de l'utilisateur par l'API d'administration de Supabase (le profil disparaît, le pseudo est libéré). Filet de sécurité : une tâche planifiée expire les invités inactifs depuis 24 h.

### 4.4 Conversion d'un invité en compte

Possible à tout moment **avant l'expiration**, une seule fois, hors partie en cours.

1. **Vers Google** : `supabase.auth.linkIdentity({ provider: 'google' })` (liaison manuelle activée dans Supabase). Le compte devient permanent immédiatement.
2. **Vers Email** : `supabase.auth.updateUser({ email })`, Supabase envoie un lien de confirmation ; le compte devient permanent **après confirmation**, puis l'app demande le mot de passe (`updateUser({ password })`). **Tant que l'email n'est pas confirmé, le compte reste invité et peut expirer** : l'app affiche « Confirmez votre email avant de vous déconnecter, sinon vos jetons seront perdus. »
3. Si l'identité appartient déjà à un compte (erreur Supabase « identité déjà utilisée ») : l'app affiche `IDENTITY_ALREADY_REGISTERED`, la conversion est refusée et l'invité reste invité.
4. Après conversion : `sync_account(pseudo?, device_id)`. Le compte **conserve son solde** et son pseudo (modifiable via `pseudo`), et reçoit le **complément de bienvenue de 4 000 jetons** (5 000 − 1 000 déjà reçus), selon les règles du §9.

### 4.5 Sessions & suppression de compte

* Sessions gérées par Supabase Auth : jeton d'accès d'**1 h** (valeur par défaut) rafraîchi automatiquement par `supabase-js`. Le même jeton sert pour le Worker et les WebSockets.
* Déconnexion d'un compte Google/Email (`signOut`) : les jetons sont conservés.
* **Suppression de compte** (obligatoire) : `DELETE /api/account` (Worker) → `prepare_account_deletion` (solde vidé vers `SYSTEM:BURN`, identités enregistrées dans `used_identities`), puis suppression de l'utilisateur via l'API d'administration de Supabase. Le profil est effacé ; les écritures du journal sont conservées sans donnée personnelle.

---

## 5. Portefeuille

### 5.1 Affichage

* Le solde est affiché en permanence dans l'en-tête de l'app.
* Le solde se met à jour en direct : l'app s'abonne via **Supabase Realtime** aux changements de **sa** ligne de la table `wallets` (§11.2).
* Écran « Historique » : les **50 dernières opérations** (date, libellé, montant, solde après), avec pagination.

### 5.2 Exécution d'une opération (procédure unique)

Toute opération passe par une seule fonction SQL, `private.transfer(from, to, amount, type, ref_type, ref_id, idempotency_key)` (déjà écrite dans `schema_supabase.sql`) :

1. Ouvrir une transaction de base de données.
2. Si une écriture avec `idempotency_key` existe déjà : renvoyer le résultat existant sans rien faire.
3. Verrouiller les deux portefeuilles (`SELECT … FOR UPDATE`, **toujours dans l'ordre alphabétique de `owner_id`** pour éviter les interblocages).
4. Si `from` est un joueur et que `balance < amount` : annuler et renvoyer `INSUFFICIENT_BALANCE`.
5. Mettre à jour les deux soldes, insérer les deux écritures (`-amount` et `+amount`).
6. Valider la transaction. Supabase Realtime notifie automatiquement le navigateur du joueur concerné.

### 5.3 Types d'opération

| Type | De → Vers | Montant | Déclencheur |
| ----- | ----- | ----- | ----- |
| `WELCOME_BONUS` | MINT → joueur | 5 000 | Création Google, ou vérification email |
| `GUEST_BONUS` | MINT → invité | 1 000 | Création d'un invité |
| `GUEST_CONVERSION_BONUS` | MINT → joueur | 4 000 | Conversion d'un invité (§4.4) |
| `DAILY_BONUS` | MINT → joueur | 400 | Réclamation du bonus quotidien (§8) |
| `ENTRY_FEE` | joueur → GAME | frais du salon | Lancement de la partie (§6.3) |
| `POT_PAYOUT` | GAME → gagnant | cagnotte − commission | Fin de partie avec gagnant |
| `HOUSE_COMMISSION` | GAME → HOUSE | 10 % de la cagnotte | Fin de partie avec gagnant |
| `REFUND` | GAME → joueur | frais payés | Partie nulle ou annulée (§7) |
| `GUEST_EXPIRY` | invité → BURN | tout le solde | Expiration d'un invité (§4.3) |
| `ACCOUNT_DELETION` | joueur → BURN | tout le solde | Suppression de compte |
| `ADMIN_ADJUSTMENT` | MINT ↔ joueur | variable | Correction manuelle, avec motif obligatoire |
| `AD_REWARD` | MINT → joueur | — | **Réservé, hors MVP** (§13) |

### 5.4 Clés d'idempotence (format imposé)

| Type | Clé |
| ----- | ----- |
| `WELCOME_BONUS` | `welcome:{user_id}` |
| `GUEST_BONUS` | `guest:{user_id}` |
| `GUEST_CONVERSION_BONUS` | `welcome:{user_id}` (même clé que le bonus de bienvenue : un seul des deux peut exister) |
| `DAILY_BONUS` | `daily:{user_id}:{AAAA-MM-JJ}` (date à Douala) |
| `ENTRY_FEE` | `fee:{game_id}:{user_id}` |
| `POT_PAYOUT` | `payout:{game_id}` |
| `HOUSE_COMMISSION` | `commission:{game_id}` |
| `REFUND` | `refund:{game_id}:{user_id}` |
| `GUEST_EXPIRY` | `expiry:{user_id}` |
| `ACCOUNT_DELETION` | `deletion:{user_id}` |
| `ADMIN_ADJUSTMENT` | `admin:{uuid}` |

---

## 6. Frais de participation

### 6.1 Montants autorisés

* De **200 à 10 000**, par paliers de **100**. **Il n'existe pas de partie gratuite.** Valeur par défaut à la création : **200** (le minimum).
* Écran « Créer une partie » : boutons − / +. Le bouton − est désactivé à 200 ; le bouton + est désactivé à 10 000 **et** dès que le palier suivant dépasse le solde du créateur.
* Un joueur dont le solde est **inférieur à 200** ne peut ni créer ni rejoindre de salon. L'app lui affiche « Solde insuffisant pour jouer » et le bouton du bonus quotidien (§8).
* Le serveur rejette tout montant hors de ces règles (`INVALID_FEE`).

### 6.2 Créer et rejoindre un salon

| Vérification | Moment | Erreur si échec |
| ----- | ----- | ----- |
| Le joueur n'est dans aucun autre salon | Création, entrée | `ALREADY_IN_ROOM` |
| Solde ≥ frais | Création, entrée | `INSUFFICIENT_BALANCE` (avec le montant manquant) |
| Invité : salon public uniquement ; un invité ne peut pas créer de salon privé | Création, entrée | `GUEST_NOT_ALLOWED` |
| Email vérifié (comptes Email) | Création, entrée | `EMAIL_NOT_VERIFIED` |

Les frais **ne sont pas débités** à l'entrée dans le salon. Quitter un salon avant le lancement ne coûte rien.

### 6.3 Lancement de la partie

1. Le serveur crée `game_id` et le portefeuille `GAME:{game_id}` (solde 0).
2. Pour chaque joueur, `transfer(joueur → GAME, frais, ENTRY_FEE)`.
3. Si un débit échoue (cas théorique), ce joueur est **retiré** du salon et prévenu (`INSUFFICIENT_BALANCE`). La partie démarre si au moins 2 joueurs restent ; sinon tous les débits déjà faits sont remboursés (`REFUND`) et le salon revient en attente.
4. **Cagnotte** = frais × nombre de joueurs débités. Elle est affichée à tous au début de la partie.

### 6.4 Fin de partie avec un gagnant

Y compris une victoire par forfait.

1. **Commission** = `floor(cagnotte × 10 / 100)`.
2. **Gain** = cagnotte − commission.
3. `transfer(GAME → gagnant, gain, POT_PAYOUT)` puis `transfer(GAME → HOUSE, commission, HOUSE_COMMISSION)`. Le solde de `GAME:{id}` doit être 0 ; sinon, alerte technique.
4. Écran de fin : cagnotte, commission, gain, **gain net** (gain − frais payés par le gagnant).

| Joueurs | Frais | Cagnotte | Commission (10 %) | Gain du vainqueur | Gain net |
| ----- | ----- | ----- | ----- | ----- | ----- |
| 2 | 200 | 400 | 40 | 360 | +160 |
| 4 | 200 | 800 | 80 | 720 | +520 |
| 6 | 200 | 1 200 | 120 | 1 080 | +880 |
| 3 | 1 000 | 3 000 | 300 | 2 700 | +1 700 |

### 6.5 Abandon et forfait

Un joueur qui abandonne ou est déclaré forfait **perd ses frais**, qui restent dans la cagnotte. Il ne reçoit rien.

---

## 7. Remboursements

| Situation | Traitement |
| ----- | ----- |
| **Partie nulle** (blocage, cahier des charges §7.4) | Chaque joueur débité reçoit `REFUND` de ses frais, **y compris ceux qui ont abandonné**. Pas de commission |
| **Partie annulée pour raison technique** (serveur redémarré sans pouvoir reprendre la partie, ou partie encore en cours **2 h** après son lancement) | Même traitement que la partie nulle |

---

## 8. Bonus quotidien

* **Montant :** 400 jetons, soit 2 parties au minimum de 200. Comptes Google et Email vérifiés uniquement.
* **Réclamation manuelle :** bouton « Bonus du jour » (`rpc('claim_daily_bonus')`). Rien n'est crédité automatiquement.
* **Une fois par jour calendaire**, heure de **Douala (UTC+1)**. Remise à zéro à **00:00**.
* Pas de cumul : un jour non réclamé est perdu.
* Disponible quel que soit le solde.
* Déjà réclamé : erreur `DAILY_BONUS_ALREADY_CLAIMED` avec `next_available_at`. Le bouton affiche alors un compte à rebours jusqu'à minuit.

---

## 9. Bonus de bienvenue : règles d'attribution

Le bonus de 5 000 est crédité **une seule fois par identité** :

1. Pas de bonus si `welcome_bonus_status` vaut déjà `GRANTED` ou `DENIED` sur le profil.
2. Pas de bonus si l'identité (Google `sub` ou email normalisé) a déjà été utilisée par un compte supprimé. La table `used_identities` conserve un **hash SHA-256** de l'identité, sans donnée personnelle.
3. Pas de bonus si le `device_id` a déjà reçu **2 bonus de bienvenue** (§10). Le compte est créé normalement, avec un solde de 0, et le joueur voit le message « Bonus de bienvenue déjà utilisé sur cet appareil ».
4. Le complément de conversion d'un invité (§4.4) suit les mêmes règles et compte comme un bonus de bienvenue pour la limite par appareil.

---

## 10. Anti-abus

| Risque | Mesure |
| ----- | ----- |
| Créer plusieurs comptes pour cumuler les bonus | 1 bonus par identité (§9) ; **2 bonus de bienvenue maximum par appareil** |
| Créer des invités en série | **3 comptes invités maximum par appareil et par 24 h** (`GUEST_LIMIT_REACHED`) |
| Faire perdre un compte secondaire pour transférer des jetons | Pas de transfert direct (P2) ; invités limités aux salons publics ; un seul salon à la fois (P8) ; commission de 10 % sur chaque partie |
| Rejouer une requête pour être crédité deux fois | Clés d'idempotence (§5.4) |
| Robots | Turnstile et limites de débit de Supabase Auth ; limites des WebSockets (protocole §8) |
| Fraude non détectée | Journal complet, consultable par un administrateur ; détection automatique de collusion hors MVP |

---

## 11. Interfaces (API)

### 11.1 Où se trouve chaque opération

| Opération | Appel | Côté | Erreurs |
| ----- | ----- | ----- | ----- |
| Connexion Google | `auth.signInWithOAuth({ provider: 'google' })` | Supabase Auth | — |
| Inscription email | `auth.signUp(...)` | Supabase Auth | `EMAIL_TAKEN`, `WEAK_PASSWORD`, `INVALID_EMAIL` |
| Connexion email | `auth.signInWithPassword(...)` | Supabase Auth | `INVALID_CREDENTIALS`, `RATE_LIMITED` |
| Renvoi de l'email de vérification | `auth.resend({ type: 'signup' })` | Supabase Auth | `RATE_LIMITED` |
| Mot de passe oublié | `auth.resetPasswordForEmail` puis `auth.updateUser({ password })` | Supabase Auth | `WEAK_PASSWORD` |
| Invité | `auth.signInAnonymously(...)` | Supabase Auth | `RATE_LIMITED` |
| Conversion d'un invité | `auth.linkIdentity({ provider: 'google' })` ou `auth.updateUser({ email })` | Supabase Auth | `IDENTITY_ALREADY_REGISTERED` |
| Profil, bonus, synchronisation | `rpc('sync_account', { p_pseudo, p_device_id })` | Supabase (SQL) | `UNAUTHORIZED`, `GUEST_LIMIT_REACHED`, `INVALID_PSEUDO`, `PSEUDO_TAKEN` |
| Bonus quotidien | `rpc('claim_daily_bonus')` | Supabase (SQL) | `NOT_ELIGIBLE`, `DAILY_BONUS_ALREADY_CLAIMED` |
| Solde | `from('wallets').select('balance')` + abonnement Realtime | Supabase | — |
| Historique | `from('ledger_entries').select(...).order('created_at', { ascending: false }).range(...)` | Supabase | — |
| Déconnexion d'un invité | `POST /api/guest/logout` | Worker | `IN_GAME` |
| Suppression de compte | `DELETE /api/account` | Worker | `IN_GAME` |
| Créer / rejoindre un salon | `POST /api/rooms`, WebSocket `JOIN` (protocole) | Worker / RoomDO → `check_can_join` | `INSUFFICIENT_BALANCE`, `ALREADY_IN_ROOM`, `GUEST_NOT_ALLOWED`, `EMAIL_NOT_VERIFIED`, `INVALID_FEE` |
| Débit, gain, remboursement | `start_game`, `settle_game`, `refund_game` (clé secrète) | RoomDO → Supabase | — |

Les erreurs SQL arrivent dans `error.message` (ex. `INSUFFICIENT_BALANCE:50`) ; l'app les traduit avec le tableau du §11.3. Les erreurs de Supabase Auth sont converties vers les mêmes codes.

### 11.2 Notifications en temps réel

| Événement | Mécanisme | Destinataire |
| ----- | ----- | ----- |
| Solde modifié | Supabase Realtime (`postgres_changes` sur `wallets`, filtre `owner_id = moi`) | Le joueur concerné |
| Cagnotte bloquée au lancement | `GAME_STARTED` (champ `pot`) du protocole | Tous les joueurs de la partie |
| Règlement de la partie | `GAME_OVER` (champs `pot`, `commission`, `payout`) du protocole | Tous les joueurs de la partie |
| Invité sur le point d'expirer | `GUEST_EXPIRING` du protocole (connexion `/ws/user`) | L'invité, s'il se reconnecte pendant le délai |

### 11.3 Codes d'erreur et messages affichés

| Code | Message affiché au joueur |
| ----- | ----- |
| `INSUFFICIENT_BALANCE` | « Solde insuffisant : il vous manque {n} jetons. » |
| `ALREADY_IN_ROOM` | « Vous êtes déjà dans un salon. » |
| `GUEST_NOT_ALLOWED` | « Les invités ne peuvent jouer que dans les salons publics. Créez un compte pour recevoir 5 000 jetons. » |
| `EMAIL_NOT_VERIFIED` | « Vérifiez votre email pour commencer à jouer. » |
| `INVALID_FEE` | « Montant de participation invalide. » |
| `DAILY_BONUS_ALREADY_CLAIMED` | « Bonus déjà récupéré. Prochain bonus dans {hh:mm}. » |
| `NOT_ELIGIBLE` | « Le bonus quotidien est réservé aux comptes inscrits. » |
| `GUEST_LIMIT_REACHED` | « Trop de comptes invités sur cet appareil. Créez un compte. » |
| `IDENTITY_ALREADY_REGISTERED` | « Ce compte existe déjà. Connectez-vous avec lui. » |
| `EMAIL_TAKEN` / `PSEUDO_TAKEN` | « Cet email est déjà utilisé. » / « Ce pseudo est déjà pris. » |
| `WEAK_PASSWORD` | « 8 caractères minimum, avec au moins une lettre et un chiffre. » |
| `INVALID_CREDENTIALS` | « Email ou mot de passe incorrect. » |
| `RATE_LIMITED` | « Trop de tentatives. Réessayez dans quelques minutes. » |
| `IN_GAME` | « Action impossible pendant une partie. » |

---

## 12. Configuration

Les valeurs `economy.*`, `fees.*`, `guest.*`, `antiabuse.*` et `games.*` sont dans la table `app_config` de Supabase (modifiables sans redéploiement). Les réglages d'authentification sont dans le tableau de bord de Supabase Auth.


| Clé | Valeur |
| ----- | ----- |
| `economy.welcome_bonus` | 5000 |
| `economy.guest_bonus` | 1000 |
| `economy.guest_conversion_bonus` | 4000 (= `welcome_bonus` − `guest_bonus`) |
| `economy.daily_bonus` | 400 |
| `economy.daily_bonus_timezone` | `Africa/Douala` |
| `economy.house_commission_percent` | 10 |
| `fees.min` / `fees.max` / `fees.step` | 200 / 10000 / 100 |
| `fees.default` | 200 |
| `games.abort_after_hours` | 2 |
| `guest.disconnect_grace_minutes` | 5 |
| `guest.max_per_device_per_day` | 3 |
| `antiabuse.max_welcome_bonus_per_device` | 2 |
| Mot de passe : longueur minimale, lettres et chiffres | 8, obligatoires (réglage Supabase Auth) |
| Durée du jeton d'accès | 3 600 s (réglage Supabase Auth, valeur par défaut) |
| Limites de débit de l'authentification | Valeurs par défaut de Supabase Auth ; création d'invités : 30 par heure et par IP |
| `wallet.history_page_size` | 50 |

---

## 13. Hors MVP

* **Jetons gagnés en regardant une publicité** (`AD_REWARD`) : montant, plafond quotidien et fournisseur publicitaire à définir. Le type d'opération est déjà réservé.
* Achat de jetons : **non prévu**. Il ferait perdre aux jetons leur caractère purement virtuel et demanderait une vérification juridique.
* Classement des joueurs par jetons, détection automatique de collusion.

---

## 14. Cas de test (critères d'acceptation)

| # | Situation | Résultat attendu |
| ----- | ----- | ----- |
| T1 | Nouveau compte Google | Compte `ACTIVE`, solde 5 000, une écriture `WELCOME_BONUS` |
| T2 | Compte Email créé, email non vérifié | Solde 0 ; création et entrée dans un salon refusées (`EMAIL_NOT_VERIFIED`) |
| T3 | Clic sur le lien de vérification, deux fois | Premier clic : solde 5 000. Second clic : aucun nouveau crédit |
| T4 | Nouvel invité | Solde 1 000, bandeau d'avertissement affiché |
| T5 | Invité appuie sur « Se déconnecter » et confirme | Écriture `GUEST_EXPIRY` de −1 000, utilisateur supprimé, pseudo libéré |
| T6 | Invité hors partie, connexion perdue 4 min puis retour | Compte intact |
| T7 | Invité hors partie, connexion perdue 6 min | Compte expiré, solde perdu |
| T8 | Invité perd la connexion en pleine partie | Règles de déconnexion du moteur ; expiration seulement après la fin de sa partie |
| T9 | Invité avec 700 jetons converti en compte Google | Solde 4 700, compte permanent |
| T10 | Conversion vers un email déjà inscrit | `IDENTITY_ALREADY_REGISTERED`, l'invité reste invité, solde inchangé |
| T11 | 3ᵉ compte inscrit sur le même appareil | Compte créé, solde 0, message « bonus déjà utilisé » |
| T12 | 4ᵉ invité sur le même appareil en 24 h | `GUEST_LIMIT_REACHED` |
| T13 | Bonus quotidien réclamé à 23:59 puis à 00:01 (Douala) | Deux crédits de 400 |
| T14 | Bonus quotidien réclamé deux fois le même jour | Second appel : `DAILY_BONUS_ALREADY_CLAIMED`, solde inchangé |
| T15 | Joueur avec 150 jetons tente de rejoindre un salon à 200 | `INSUFFICIENT_BALANCE`, « il vous manque 50 jetons » |
| T16 | Joueur dans un salon tente d'en rejoindre un second | `ALREADY_IN_ROOM` |
| T17 | Joueur quitte un salon avant le lancement | Aucune écriture, solde inchangé |
| T18 | Partie à 4 joueurs, frais 200, un gagnant | 4 × `ENTRY_FEE` (−200) ; `POT_PAYOUT` +720 ; `HOUSE_COMMISSION` +80 ; `GAME:{id}` à 0 |
| T19 | Partie à 3 joueurs, frais 200 : un abandon, puis un gagnant | L'abandonnant ne récupère rien ; gagnant +540 (cagnotte 600, commission 60) |
| T20 | Partie à 2 joueurs, l'adversaire abandonne | Victoire par forfait : gagnant +360 |
| T21 | Partie nulle à 3 joueurs, frais 500 | 3 × `REFUND` de 500, aucune commission |
| T22 | Serveur redémarré pendant une partie non récupérable | 2 h après le lancement au plus tard : remboursement de tous les joueurs |
| T23 | Même requête de gain envoyée deux fois (reprise réseau) | Un seul `POT_PAYOUT` (clé d'idempotence) |
| T24 | Création d'un salon à 0 ou à 100 jetons (via l'API) | `INVALID_FEE` |
| T25 | Création d'un salon à 150 jetons (via l'API) | `INVALID_FEE` |
| T26 | Invité tente de rejoindre un salon privé à 200, ou d'en créer un | `GUEST_NOT_ALLOWED` |
| T27 | Suppression d'un compte avec 3 200 jetons, puis réinscription avec le même Google | `ACCOUNT_DELETION` −3 200 ; nouveau compte créé **sans** bonus de bienvenue |
| T28 | Contrôle global | Somme des soldes de tous les portefeuilles (système compris) = 0 |
| T29 | Joueur avec 150 jetons ouvre l'écran « Créer une partie » | Message « Solde insuffisant pour jouer », bouton du bonus quotidien affiché, création impossible |

---

## 15. Choix faits par défaut (modifiables)

Ces points n'ont pas été tranchés explicitement par le porteur du projet. Ils ont été fixés pour que le document soit complet.

1. Invité : expiration après **5 min** de connexion perdue hors partie (protège des coupures réseau).
2. Invités limités aux **salons publics** (anti-transfert).
3. Conversion invité → compte : solde conservé + 4 000 jetons.
4. Frais **maximum de 10 000**, par paliers de 100.
5. **2 bonus de bienvenue** maximum par appareil.
6. Conversion par email : le compte reste invité (et peut expirer) tant que l'email n'est pas confirmé.
