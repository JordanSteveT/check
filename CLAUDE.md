# CLAUDE.md — Projet « Check »

Jeu de cartes camerounais **Check**, multijoueur en ligne, temps réel. Application **web** (PWA, mobile d'abord), hébergée sur **Cloudflare** (Workers + Durable Objects), base de données et comptes sur **Supabase**. Le projet part de zéro : tout le code est à écrire.

## Documents de référence (dossier `docs/`)

Lis `docs/plan_de_developpement.md` en premier : il donne l'ordre de lecture, les phases et les tickets.

| Document | Rôle |
| ----- | ----- |
| `docs/cahier_des_charges_check_v2.md` | **Règles du jeu**. Normatif. |
| `docs/specification_comptes_et_jetons.md` | Comptes (Google, email, invité), jetons, frais, cagnotte, bonus. Normatif. |
| `docs/protocole_temps_reel.md` | Messages WebSocket/HTTP, états, interface du moteur. Normatif. |
| `docs/architecture_technique.md` | Pile technique, composants, sécurité, environnements |
| `docs/cas_de_test_moteur.md` | Cas de test du moteur de règles (critères d'acceptation) |
| `docs/specification_ecrans.md` | Écrans et boutons de l'application |
| `docs/schema_supabase.sql`, `docs/tests_schema_supabase.sql` | Schéma SQL de référence, déjà testé, et ses scénarios |

**Priorité en cas de contradiction :** règles > jetons > protocole > le reste.

## Règles de travail

1. **Ne jamais inventer une règle de jeu.** Si un cas n'est pas couvert ou si deux documents se contredisent, arrête-toi et pose la question à l'utilisateur. Une fois tranché, corrige le document **dans le même commit** que le code.
2. **Un ticket à la fois**, dans l'ordre du plan. Annonce le ticket au début, résume ce qui a été fait à la fin (fichiers, tests, écarts).
3. **Tests d'abord pour le moteur** : chaque ligne de `cas_de_test_moteur.md` devient un test Vitest nommé par son identifiant (ex. `it("J7 — pas de jeu à la valeur sur un Joker", …)`).
4. Un ticket est terminé seulement si lint, vérification de types et tests passent (`pnpm lint && pnpm typecheck && pnpm test`).
5. Tâches qui demandent l'utilisateur (création de comptes Cloudflare/Supabase/Google, domaine, secrets, SMTP) : prépare tout ce qui peut l'être, puis donne-lui une liste d'étapes précise et attends.
6. Commits au format *Conventional Commits* (`feat(engine): …`, `test: …`, `docs: …`). Pas de commit ni de push sans accord de l'utilisateur.

## Pile technique (figée, voir l'architecture)

* TypeScript **strict** partout, monorepo **pnpm**.
* `packages/engine` : moteur de règles **pur** (aucune dépendance, aucun accès réseau, aucune horloge interne : `now` et `rng` sont passés en paramètres). Utilisé par le serveur et par l'app.
* `packages/protocol` : types et schémas **Zod** des messages.
* `apps/worker` : Cloudflare Worker + Durable Objects `RoomDO`, `UserDO`, `LobbyDO` (WebSockets en hibernation). `wrangler.jsonc`.
* `apps/web` : React + Vite, Zustand, CSS Modules, PWA.
* `supabase/` : migrations SQL (`supabase/migrations/0001_init.sql`, `0002_cron.sql`), `config.toml`.
* Tests : Vitest, `@cloudflare/vitest-pool-workers`, Playwright.

## Conventions

* **Langue** : code (identifiants, commentaires de code) en anglais ; documents, messages de commit et textes de l'interface en français. Tous les textes affichés passent par `apps/web/src/i18n/fr.json`.
* **Codage des cartes** : `7H`, `10S`, `AD`, `JC`, `XR` (Joker rouge), `XB` (Joker noir) — voir protocole §1.
* **Codes d'erreur** : exactement ceux des documents (`ILLEGAL_PLAY`, `INSUFFICIENT_BALANCE`…).
* **Configuration** : constantes de jeu dans `apps/worker/src/game_config.ts` ; valeurs économiques dans la table `app_config` de Supabase. Démarrage refusé si une clé manque.
* **Base de données** : `supabase/migrations/` est la version exécutable. Ne jamais modifier une migration déjà appliquée : toute évolution passe par une nouvelle migration `000N_…sql`.
* **Sécurité** : aucune clé ni secret dans le dépôt (`.dev.vars` et `.env*` sont ignorés). Clé Supabase *publishable* côté navigateur seulement ; clé *secrète* uniquement dans les secrets du Worker.
* **Temps réel** : aucun appel à la base de données pendant un coup ; Supabase n'est appelé qu'au lancement et à la fin d'une partie (architecture §3).

## Commandes (à créer au ticket SET-04, puis à tenir à jour ici)

```bash
pnpm install          # dépendances
pnpm test             # tous les tests
pnpm lint             # ESLint
pnpm typecheck        # tsc --noEmit sur tout le monorepo
pnpm build            # compilation de tous les paquets
pnpm format           # mise en forme Prettier
pnpm --filter engine test        # tests du moteur seul
pnpm --filter engine test:coverage   # couverture du moteur (seuil 95 %)
pnpm --filter worker dev         # wrangler dev (serveur local)
pnpm --filter web dev            # application web locale
supabase start                   # base locale (Docker requis)
```
