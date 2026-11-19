# Plan de développement — Check (application web)

Point d'entrée du dossier technique : **quoi lire, dans quel ordre, et quoi construire, dans quel ordre.**

> **Version 1.0 — 19/11/2026.** Application web, de zéro, Cloudflare + Supabase, temps réel.

---

## 1. Le dossier à remettre au développeur

| # | Document | Contenu | À lire |
| ----- | ----- | ----- | ----- |
| 1 | `plan_de_developpement.md` | Ce document : ordre de lecture, phases, tickets, critères de fin | En premier |
| 2 | `cahier_des_charges_check_v2.md` | **Règles du jeu** (normatives), options de partie R1 à R8 | Avant tout code |
| 3 | `specification_comptes_et_jetons.md` | Comptes (Google, email, invité), jetons, frais, cagnotte, bonus | Avant la phase 3 |
| 4 | `architecture_technique.md` | Choix techniques, composants, flux, sécurité, environnements, coûts | Avant tout code |
| 5 | `protocole_temps_reel.md` | Messages WebSocket et HTTP, états du salon et de la partie, interface du moteur | Avant la phase 2 |
| 6 | `schema_supabase.sql` | Base de données complète (tables, sécurité, fonctions) — **testée** | Phase 0 |
| 7 | `tests_schema_supabase.sql` | Scénarios de test SQL du schéma | Phase 0 |
| 8 | `cas_de_test_moteur.md` | Plus de 130 cas de test des règles | Phase 1 |
| 9 | `specification_ecrans.md` | Chaque écran, chaque bouton | Phase 4 |

En cas de contradiction : les **règles** priment (doc 2), puis les **jetons** (doc 3), puis le **protocole** (doc 5). Toute contradiction trouvée est signalée au porteur du projet et corrigée dans le document, jamais seulement dans le code.

---

## 2. Phases

Estimations pour **un développeur full-stack TypeScript expérimenté**. Avec deux développeurs (un serveur, un interface), compter environ 60 % de la durée à partir de la phase 2.

| Phase | Contenu | Durée | Fin de phase quand… |
| ----- | ----- | ----- | ----- |
| **0. Mise en place** | Comptes, dépôt, CI, environnements, base de données, mesures de latence | 3 jours | Un « Hello » déployé en préproduction parle à Supabase ; la migration SQL est appliquée et ses tests passent |
| **1. Moteur de règles** | `packages/engine` | 1,5 semaine | 100 % des cas de `cas_de_test_moteur.md` passent ; couverture ≥ 95 % |
| **2. Serveur temps réel** | `packages/protocol`, Worker, RoomDO, UserDO, LobbyDO | 2 semaines | Deux clients de test jouent une partie complète en WebSocket, avec reconnexion et chronomètres |
| **3. Comptes et jetons** | Supabase Auth, `sync_account`, frais, cagnotte, remboursements, expiration des invités | 1 semaine | Les cas T1 à T29 de la spécification des jetons passent en préproduction |
| **4. Application web** | Écrans E1 à E15, animations, PWA | 2,5 semaines | Parcours complet sur un Android d'entrée de gamme : inscription → partie → fin → historique |
| **5. Tests et charge** | Playwright multi-joueurs, test de charge, mesures | 1 semaine | Objectifs de latence (architecture §3.2) tenus ; 200 parties simultanées sans erreur |
| **6. Bêta fermée** | 30 à 50 joueurs au Cameroun | 2 semaines | Aucune anomalie bloquante ; réglages (durée de tour, délai invité) confirmés |
| **7. Lancement** | Production, communication | — | Liste de lancement (§6) cochée |

**Total : environ 11 semaines** jusqu'au lancement pour un développeur.

---

## 3. Tickets

Chaque ticket est terminé quand ses tests passent et que la « Définition de terminé » (§4) est respectée.

### Phase 0 — Mise en place

| Ticket | Tâche | Fait quand |
| ----- | ----- | ----- |
| SET-01 | Créer les comptes Cloudflare (Workers Paid), Supabase, GitHub ; acheter le domaine | Accès partagés au porteur du projet |
| SET-02 | Mesurer la latence depuis Douala et Yaoundé vers les régions Supabase Paris, Francfort, Londres (outil de mesure en ligne ou VPS local) | Région retenue notée dans `architecture_technique.md` §3.1 |
| SET-03 | Créer les projets Supabase `check-staging` et `check-prod` ; régler l'Auth selon `architecture_technique.md` §10 | Réglages vérifiés par capture |
| SET-04 | Monorepo pnpm (`packages/engine`, `packages/protocol`, `apps/web`, `apps/worker`, `supabase/`), TypeScript strict, ESLint, Prettier | `pnpm install && pnpm build` passe |
| SET-05 | Migration `0001_init.sql` (= `schema_supabase.sql`, partie 1) et `0002_cron.sql` (partie 2) ; exécuter `tests_schema_supabase.sql` en local (`supabase start`) | Tous les scénarios donnent le résultat attendu |
| SET-06 | CI GitHub Actions : lint, typecheck, tests sur chaque PR ; déploiement préproduction à chaque fusion sur `main` ; production sur étiquette `v*` | Une PR de test passe la CI et se déploie |
| SET-07 | Worker minimal : fichiers statiques + `/api/health` + vérification JWT Supabase (JWKS) | `/api/health` répond en préproduction ; un jeton invalide est refusé |
| SET-08 | SMTP personnalisé + enregistrements DNS (SPF, DKIM) ; écran de consentement Google OAuth | Email de vérification reçu dans Gmail, pas en spam |

### Phase 1 — Moteur de règles (`packages/engine`)

| Ticket | Tâche | Fait quand |
| ----- | ----- | ----- |
| ENG-01 | Cartes, paquet de 54, couleurs rouge/noir, mélange avec générateur injecté | Tests I1, I2, I6 |
| ENG-02 | `createGame` : distribution, carte de départ selon les options, premier joueur | Tests I1 à I8 |
| ENG-03 | Légalité d'une carte seule (enseigne, valeur, Valet, Joker, 2, couleur demandée, couleur ouverte) selon R1 à R8 | Tests P, V, J, D |
| ENG-04 | Combinaisons, ordre de pose, carte visible | Tests C |
| ENG-05 | Effets : pénalité et cumul, As et formule de saut, Valet, Joker, 2 transparent | Tests K, A |
| ENG-06 | Pioche, encaissement, épuisement et remélange, blocage | Tests R |
| ENG-07 | Annonce « Check » et fenêtre de dénonciation | Tests CH |
| ENG-08 | Victoire immédiate sur la dernière carte ; interdiction de finir sur un As à 2 joueurs | Tests W |
| ENG-09 | Temps écoulé, déconnexion, forfait, abandon | Tests F |
| ENG-10 | `getLegalMoves`, `getPlayerView` ; tests de propriétés | Tests S1 à S5 |

### Phase 2 — Serveur temps réel

| Ticket | Tâche | Fait quand |
| ----- | ----- | ----- |
| SRV-01 | `packages/protocol` : types et schémas Zod de tous les messages | Un message invalide est rejeté avec `ERROR` |
| SRV-02 | Routage du Worker : `/api/*`, `/ws/room/:id`, `/ws/user`, `/ws/lobby` | Tests de routage |
| SRV-03 | RoomDO : connexion, `AUTH` (délai 5 s), hibernation, pièces jointes (`serializeAttachment`) | Tests de connexion et de fermeture 4001 |
| SRV-04 | RoomDO : salle d'attente (`JOIN`, `LEAVE`, hôte, `UPDATE_OPTIONS`, `START`, compte à rebours public, durée de vie 300 s) | Machine à états du protocole §4.1 couverte |
| SRV-05 | RoomDO : partie (appels au moteur, `seq`, diffusion, vues privées) | Partie complète entre 2 clients de test |
| SRV-06 | RoomDO : gestionnaire d'échéances sur une seule alarme (protocole §9), idempotent | Tests avec horloge simulée |
| SRV-07 | RoomDO : sauvegarde de l'état après chaque coup ; reprise après redémarrage | Test : redémarrage en pleine partie, la partie continue |
| SRV-08 | Reconnexion, `SYNC`, connexion remplacée (4003), limites de débit (4008) | Tests protocole §7 et §8 |
| SRV-09 | UserDO : présence, salon actuel (`claimRoom` / `releaseRoom`), `CURRENT_ROOM` | Un joueur ne peut pas être dans deux salons |
| SRV-10 | LobbyDO : liste des salons publics, `QUICK_PLAY` | Deux clients voient la liste se mettre à jour |
| SRV-11 | `PING`/`PONG`, journalisation structurée (`roomId`, `gameId`, `userId`) | Latence visible dans les journaux |

### Phase 3 — Comptes et jetons

| Ticket | Tâche | Fait quand |
| ----- | ----- | ----- |
| ECO-01 | Client Supabase côté app : Google, email, invité (Turnstile), `sync_account`, `device_id` (identifiant aléatoire stocké dans le navigateur) | Cas T1 à T4 |
| ECO-02 | Conversion invité → Google (liaison d'identité) et → email | Cas T9, T10 |
| ECO-03 | `POST /api/rooms` et revérification au `JOIN` (`check_can_join`) | Cas T15, T16, T24 à T26, T29 |
| ECO-04 | Lancement : `start_game` ; fin : `settle_game` / `refund_game` avec 5 nouvelles tentatives ; alerte si échec | Cas T17 à T23 |
| ECO-05 | Expiration des invités (UserDO, alarme à 5 min, attente de fin de partie) ; `POST /api/guest/logout` | Cas T5 à T8 |
| ECO-06 | Suppression de compte (`DELETE /api/account`) | Cas T27 |
| ECO-07 | Bonus du jour (`claim_daily_bonus`), solde en direct (Realtime sur `wallets`) | Cas T13, T14 |
| ECO-08 | Tâches planifiées `pg_cron` et table `ops_alerts` surveillée | Cas T28 ; une alerte de test arrive à l'équipe |

### Phase 4 — Application web

| Ticket | Tâche | Fait quand |
| ----- | ----- | ----- |
| WEB-01 | Squelette React/Vite, routage, Zustand, traductions `fr.json`, thème (variables CSS) | Navigation entre écrans vides |
| WEB-02 | E1 à E4 (connexion, pseudo, vérification email) | Parcours des 3 types de comptes |
| WEB-03 | E5 Accueil (solde en direct, bonus, bandeau invité, partie en cours) | — |
| WEB-04 | E6, E7, E8, E9 (création, liste, code, salle d'attente, partage du lien) | Invitation via WhatsApp fonctionnelle |
| WEB-05 | Jeu de cartes SVG original (sprite) et composants Carte, Main, Talon, Pioche | Rendu net sur écran 360 px |
| WEB-06 | E10 Table : état depuis `STATE` et événements ; cartes jouables (moteur partagé) ; pose optimiste et annulation | Partie complète jouable |
| WEB-07 | E10 : combinaisons, choix de couleur, « Encaisser », CHECK, Dénoncer, chronomètres, horloge synchronisée | Tous les cas visibles d'une partie |
| WEB-08 | Animations, sons, vibrations, titre clignotant | 60 images/s sur l'appareil de référence |
| WEB-09 | Reconnexion (bandeau), fermetures 4002/4003, hors ligne | Coupure Wi-Fi en pleine partie : reprise sans perte |
| WEB-10 | E11, E12, E13, E14, E15 | — |
| WEB-11 | PWA : manifeste, service worker (coquille hors ligne), invitation à installer | Score Lighthouse PWA valide ; installation sur Android |
| WEB-12 | Budget de poids (< 200 Ko JS initial) et chargement différé | Vérifié en CI |

### Phase 5 — Tests et charge

| Ticket | Tâche | Fait quand |
| ----- | ----- | ----- |
| QA-01 | Playwright : 3 navigateurs = 3 joueurs, partie complète, abandon, reconnexion, partie nulle | Tests verts en CI (sur préproduction) |
| QA-02 | Robots de charge : 200 salons de 4 joueurs jouant des coups aléatoires légaux | 0 erreur serveur ; p95 de confirmation de coup tenu |
| QA-03 | Mesures réelles depuis le Cameroun (Orange, MTN, Camtel ; 3G et 4G) | Rapport de latence ; réglage `locationHint` décidé |
| QA-04 | Revue de sécurité : RLS, droits des fonctions, secrets, en-têtes, Turnstile | Liste de contrôle signée |

---

## 4. Définition de « terminé »

Un ticket est terminé quand :

1. Le code est fusionné sur `main` après revue (PR).
2. Lint, vérification de types et tests passent en CI.
3. Les cas de test cités dans le ticket sont automatisés et passent.
4. Aucun secret dans le code ; nouvelles variables documentées.
5. Le comportement est conforme aux documents ; sinon, le document est corrigé (avec accord du porteur du projet) **dans la même PR**.
6. Déployé et vérifié en préproduction.

---

## 5. Conventions

* **Branches** : `main` (préproduction automatique), branches `feat/…`, `fix/…` ; production sur étiquette `vX.Y.Z`.
* **Commits** : style *Conventional Commits* (`feat:`, `fix:`, `test:`, `docs:`).
* **Code** : TypeScript strict, aucune `any` non justifiée ; le moteur sans dépendance ; fonctions pures dans le moteur.
* **Base de données** : toute modification par une **nouvelle** migration (`supabase/migrations/000N_…sql`), jamais en modifiant une migration déjà appliquée.
* **Configuration** : valeurs de jeu dans `game_config` (Worker) ; valeurs économiques dans la table `app_config` (Supabase). Le serveur refuse de démarrer si une clé manque.

---

## 6. Liste de lancement

| Élément | Vérifié |
| ----- | ----- |
| Supabase production en offre Pro, sauvegardes actives | ☐ |
| Cloudflare Workers Paid ; domaine et certificat | ☐ |
| Google OAuth : écran de consentement publié, domaines autorisés | ☐ |
| SMTP : SPF, DKIM, DMARC ; emails reçus hors spam (Gmail, Yahoo) | ☐ |
| Turnstile actif sur l'authentification | ☐ |
| Conditions d'utilisation et politique de confidentialité en ligne (jetons sans valeur monétaire, données collectées, suppression de compte) | ☐ |
| Alertes techniques reliées à un email ou une messagerie de l'équipe | ☐ |
| Tous les tests verts sur la version étiquetée | ☐ |
| Bêta : retours traités, réglages confirmés | ☐ |
