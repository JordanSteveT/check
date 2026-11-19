# Premier message à envoyer à Claude Code

Copie le texte ci-dessous dans Claude Code, une fois ouvert dans le dossier `check`.

---

Bonjour. Tu vas implémenter le jeu de cartes « Check » à partir des documents du dossier `docs/`.

1. Lis `CLAUDE.md`, puis `docs/plan_de_developpement.md`, puis `docs/cahier_des_charges_check_v2.md` et `docs/protocole_temps_reel.md` (§12, interface du moteur).
2. Résume-moi en quelques lignes ce que tu as compris de l'architecture et des règles, et signale toute contradiction ou zone floue que tu repères dans les documents.
3. Ensuite, réalise le ticket **SET-04** (monorepo pnpm, TypeScript strict, ESLint, Prettier, Vitest, scripts `test` / `lint` / `typecheck`), puis enchaîne sur la **phase 1 — moteur de règles** (tickets ENG-01 à ENG-10), en écrivant d'abord les tests de `docs/cas_de_test_moteur.md`.
4. Arrête-toi après chaque ticket pour me montrer le résultat des tests et me demander si tu continues.

Ne crée aucun compte en ligne et ne fais aucun commit sans me le demander. Si une règle n'est pas claire, pose-moi la question au lieu de l'inventer.
