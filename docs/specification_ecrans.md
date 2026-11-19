# Spécification des écrans — Check (application web)

Ce document décrit **chaque écran** de l'application, ce qu'il affiche et ce que fait chaque bouton. Les messages échangés avec le serveur sont ceux de `protocole_temps_reel.md` ; les textes d'erreur sont ceux du protocole (§11) et de la spécification des jetons (§11.3).

> **Version 1.0 — 19/11/2026.**

---

## 1. Principes d'interface

| Sujet | Règle |
| ----- | ----- |
| Cible | **Mobile d'abord** : écran de référence 360 × 640 px, Android d'entrée de gamme, Chrome. Doit aussi fonctionner sur ordinateur (table centrée, largeur max 480 px pour les menus, 960 px pour la table) |
| Orientation | Portrait sur mobile. Paysage accepté sur ordinateur et tablette |
| Langue | Français. Tous les textes dans des fichiers de traduction (`fr.json`) pour ajouter l'anglais plus tard sans toucher au code |
| Identité visuelle | Tapis **vert** dégradé, accents **orange** (boutons principaux), cartes blanches lisibles. Cartes et visuels **originaux** (jeu de cartes SVG dessiné pour le projet, un seul fichier « sprite » mis en cache) |
| Zones tactiles | 44 × 44 px minimum ; jamais deux actions à moins de 8 px l'une de l'autre |
| Accessibilité | Contraste AA ; enseignes reconnaissables aussi par leur forme (pas seulement la couleur) ; tailles de texte en `rem` |
| Animations | `transform` et `opacity` uniquement, 60 images/s ; durée standard 250 ms ; désactivées si l'utilisateur demande moins d'animations (`prefers-reduced-motion`) |
| Sons et vibrations | Sons courts (< 20 Ko chacun) : carte posée, pioche, « à vous de jouer », victoire. Vibration de 100 ms quand c'est son tour (si le navigateur le permet). Réglables dans les paramètres |
| Hors ligne | L'app s'installe (PWA) et s'ouvre sans réseau sur un écran « Pas de connexion » avec bouton « Réessayer » |
| Poids | JavaScript initial < 200 Ko compressés ; images et sons chargés après l'affichage du premier écran |

---

## 2. Carte des écrans

```
E1 Bienvenue ──► E2 Email (connexion / inscription) ──► E4 Vérifiez votre email
   │  └─► Google ──────────────┐                              │
   │                           ▼                              ▼
   └─► Invité ───────────► E3 Pseudo (comptes inscrits, 1ʳᵉ fois) ──► E5 Accueil
                                                                      │
       ┌──────────────┬───────────────┬──────────────┬───────────────┼──────────┐
       ▼              ▼               ▼              ▼               ▼          ▼
  Partie rapide  E7 Salons publics  E6 Créer   E8 Rejoindre (code)  E12 Portefeuille  E13 Paramètres
       └──────────────┴───────────────┴──────────────┘                          │
                                ▼                                               ▼
                         E9 Salle d'attente ──► E10 Table de jeu ──► E11 Fin de partie
```

Lien d'invitation : `https://{domaine}/r/{code}` ouvre directement E8 avec le code rempli (après connexion si besoin).

---

## 3. Écrans

### E1 — Bienvenue (non connecté)

* Logo « Check », phrase d'accroche : « Le jeu de cartes camerounais, en ligne avec tes amis. »
* Boutons, dans cet ordre :
  1. **« Continuer avec Google »** → connexion Google Supabase (redirection), puis E3 si pas de pseudo, sinon E5.
  2. **« Continuer avec un email »** → E2.
  3. **« Jouer en invité »** (bouton secondaire) → Turnstile invisible, connexion anonyme, `sync_account`, puis E5. Sous le bouton : « 1 000 jetons, perdus à la déconnexion ».
* Lien « Règles du jeu » → E14.
* Erreur `GUEST_LIMIT_REACHED` : message, et mise en avant des deux premiers boutons.

### E2 — Email

* Onglets **« Se connecter »** / **« Créer un compte »**.
* Se connecter : email, mot de passe, bouton « Se connecter », lien « Mot de passe oublié ? » (saisie de l'email → « Si un compte existe, un email a été envoyé. »).
* Créer un compte : email, mot de passe (règle affichée sous le champ), pseudo, case « J'accepte les conditions d'utilisation » (lien), bouton « Créer mon compte » → E4.
* Turnstile invisible sur les deux formulaires.

### E3 — Choix du pseudo

* Champ pseudo (3 à 16 caractères, lettres, chiffres, `_`), vérification à la saisie (format).
* Bouton « Valider » → `sync_account(pseudo, device_id)`. Erreur `PSEUDO_TAKEN` affichée sous le champ.
* Après validation : si un bonus est accordé, animation « +5 000 jetons » puis E5. Si `DENIED_DEVICE` ou `DENIED_IDENTITY` : message correspondant de la spécification des jetons, puis E5.

### E4 — Vérifiez votre email

* « Un lien a été envoyé à {email}. Cliquez dessus pour activer votre compte et recevoir 5 000 jetons. »
* Bouton « Renvoyer l'email » (désactivé 60 s après chaque envoi).
* Bouton « J'ai cliqué sur le lien » → rafraîchit la session puis `sync_account`.
* Le lien de l'email ramène sur l'app, qui appelle `sync_account` automatiquement.

### E5 — Accueil (connecté)

* **En-tête** : pseudo, solde de jetons (mis à jour en direct), icône réseau, menu (E12, E13, E14).
* **Bandeau invité** (invités uniquement, non masquable) : « Compte invité : vos jetons seront perdus à la déconnexion. » + bouton « Créer un compte (+4 000 jetons) » → conversion (E15).
* **Bonus du jour** (comptes inscrits) : bouton « Récupérer 400 jetons » ou, s'il est déjà pris, « Prochain bonus dans hh:mm ».
* **Boutons principaux** :
  1. **« Partie rapide »** : choix du montant (200 par défaut, − / +), puis `QUICK_PLAY` → E9.
  2. **« Salons publics »** → E7.
  3. **« Créer une partie »** → E6.
  4. **« Rejoindre avec un code »** → E8.
* Solde < 200 : les 4 boutons sont désactivés, message « Solde insuffisant pour jouer » et mise en avant du bonus du jour.
* Si le serveur signale une partie en cours (`CURRENT_ROOM`) : carte « Partie en cours — Revenir » en haut de l'écran.

### E6 — Créer une partie

* **Type** : « Privée (avec un code) » / « Publique ». Les invités ne voient que « Publique ».
* **Frais de participation** : valeur centrale (200 par défaut), boutons − (désactivé à 200) et + (désactivé à 10 000 ou si le palier suivant dépasse le solde). Sous la valeur : « Cagnotte : frais × joueurs, moins 10 % ».
* **Règles du jeu** : les 8 cases à cocher, avec les libellés exacts du cahier des charges §2.2, toutes cochées par défaut. Lien « ? » à côté de chaque règle → explication courte.
* Bouton **« Créer »** → `POST /api/rooms` → E9.

### E7 — Salons publics

* Liste en direct (`/ws/lobby`) : montant, joueurs (ex. 3/6), règles différentes de celles par défaut (badges), compte à rebours si démarré.
* Filtre par montant (tous, 200, 500, 1 000, plus).
* Appui sur un salon → E9. Liste vide : « Aucun salon ouvert » + bouton « Créer une partie publique ».

### E8 — Rejoindre avec un code

* Champ code (6 caractères, majuscules automatiques), bouton « Rejoindre » → `GET /api/rooms/by-code/{code}` → E9.
* Erreurs : `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_LOCKED`, `INSUFFICIENT_BALANCE`, `GUEST_NOT_ALLOWED`.

### E9 — Salle d'attente

* **En-tête** : type de salon, frais, cagnotte prévue.
* **Salon privé** : code en grand + bouton **« Inviter »** (partage natif du téléphone avec le lien `https://{domaine}/r/{code}`, notamment vers WhatsApp ; sinon copie du lien).
* **Sièges** : 6 emplacements ; joueurs présents (pseudo, badge « Hôte ») ; emplacements vides en pointillés.
* **Règles** : résumé des 8 options. L'hôte peut les modifier (même écran qu'E6, en fenêtre) tant que la partie n'est pas lancée.
* **Boutons** :
  * Hôte d'un salon privé : **« Lancer la partie »** (actif à partir de 2 joueurs).
  * Salon public : compte à rebours « Début dans 0:45 » dès 2 joueurs.
  * Tous : « Quitter ».
* Quand le serveur envoie `GAME_STARTING` : animation « Distribution… » jusqu'à `GAME_STARTED`, puis E10.

### E10 — Table de jeu

```
┌──────────────────────────────────────┐
│  [B 4🂠]      [C 6🂠 ⏱]      [D 2🂠 CHECK] │ ← adversaires
│                                      │
│        ┌─────┐   ┌─────┐             │
│        │ 🂠  │   │ 7♥  │  ♦ demandé   │ ← pioche · talon · indicateurs
│        │ 23  │   └─────┘  +4 à piocher│
│        └─────┘                       │
│   Cagnotte 800                    📶 │
│                                      │
│  [Piocher]        [CHECK]  [Dénoncer]│ ← actions
│   ╭───╮╭───╮╭───╮╭───╮╭───╮           │
│   │5♥ ││7♠ ││J♦ ││9♣ ││X  │           │ ← main (jouables surélevées)
│   ╰───╯╰───╯╰───╯╰───╯╰───╯           │
└──────────────────────────────────────┘
```

**Adversaires** (en haut, disposés dans l'ordre de jeu) : pseudo, nombre de cartes, anneau de chronomètre autour du joueur dont c'est le tour, icône de déconnexion, badge « CHECK » s'il a annoncé, grisé s'il a abandonné.

**Centre** :

* Pioche avec le nombre de cartes restantes.
* Talon : carte visible en grand.
* Indicateur de **couleur demandée** (Valet) : icône de l'enseigne + « ♦ demandé ».
* Indicateur de **couleur ouverte** (Joker) : « Rouge : ♥ ou ♦ » / « Noir : ♠ ou ♣ ».
* Indicateur de **pénalité en cours** : « +4 à piocher » en rouge, avec qui est visé.
* Cagnotte de la partie.

**Main du joueur** (en bas) :

* Cartes en éventail, triées par enseigne puis valeur. Si elles ne tiennent pas, défilement horizontal.
* Pendant son tour : cartes **jouables surélevées**, les autres **grisées** (calcul local avec le moteur partagé ; le serveur reste seul juge).
* **Jouer une carte** :
  * Appui sur une carte jouable : si aucune autre carte de même valeur (ni 7/Joker combinable) n'est en main, **elle part immédiatement** vers le talon.
  * Sinon, elle est **sélectionnée** ; l'appui sur d'autres cartes compatibles les ajoute, dans l'ordre d'appui (la dernière sera visible). Le bouton « Poser (n) » apparaît.
  * Glisser une carte vers le talon : même effet qu'un appui.
* **Valet** (option R2) : à la pose, fenêtre de choix des 4 enseignes (gros boutons). Le coup n'est envoyé qu'après le choix.
* Retour visuel immédiat, puis confirmation du serveur ; en cas de refus, la carte revient en main avec le message d'erreur.

**Boutons d'action** :

| Bouton | Visible quand | Effet |
| ----- | ----- | ----- |
| **« Piocher »** | Son tour, sans pénalité | `DRAW` (1 carte) |
| **« Encaisser +N »** (rouge) | Son tour, pénalité active | `DRAW` (toute la pénalité) |
| **« CHECK »** | Son tour, s'il a 2 cartes ou plus et qu'un coup peut le laisser à 1 carte | Armé/désarmé (bouton allumé). Le prochain coup qui le laisse à 1 carte part avec `declareCheck: true`. Le joueur doit y penser lui-même : l'app ne l'arme jamais automatiquement |
| **« Dénoncer »** (clignote) | Un adversaire vient d'oublier son « Check » (`CHECK_WINDOW`) | `CALL_CHECK` |
| Menu ⋮ | Toujours | « Règles », « Son », « Abandonner » (confirmation : « Vous perdrez vos {frais} jetons. ») |

**Chronomètre** : anneau autour de l'avatar du joueur courant ; pour soi, barre au-dessus de la main qui passe à l'orange à 10 s et au rouge à 5 s (vibration courte à 5 s).

**Événements animés** : carte posée (trajet main → talon), pioche (pioche → main ou → adversaire), As (icône « passe son tour » sur le joueur sauté), pénalité (compteur qui grossit), Valet (enseigne demandée qui s'agrandit), Joker (halo de la couleur ouverte), Check (bulle « CHECK ! » sur le joueur), dénonciation (bulle « Dénoncé ! +2 »).

**Coupure réseau** : bandeau orange « Reconnexion… » ; boutons de jeu désactivés jusqu'au retour de la connexion.

**Onglet en arrière-plan** : quand c'est son tour, le titre de l'onglet clignote (« À vous de jouer ! ») et un son est joué.

### E11 — Fin de partie

* Titre : « Victoire ! » / « {pseudo} gagne » / « Partie nulle » / « Partie annulée ».
* Détail : cagnotte, commission (10 %), gain du vainqueur ; pour soi : gain net (ex. « +520 ») ou perte (« −200 »).
* Mains restantes de chacun (cartes visibles).
* Boutons : **« Rejouer »** (crée un nouveau salon avec les mêmes réglages ; dans un salon privé, propose aux mêmes joueurs de le rejoindre via un message dans la salle d'attente), **« Accueil »**.
* Invité : rappel « Créez un compte pour garder vos jetons. »

### E12 — Portefeuille

* Solde, bouton du bonus du jour.
* Historique (50 dernières opérations, puis « Voir plus ») : date, libellé clair (« Bonus de bienvenue », « Participation à une partie », « Gain de partie », « Remboursement », « Bonus du jour »…), montant coloré (vert / rouge), solde après.

### E13 — Paramètres

* Profil : pseudo (modifiable pour les comptes inscrits), type de compte, email.
* Invité : bouton « Créer un compte et garder mes jetons » (E15).
* Son, vibrations, animations réduites.
* « Règles du jeu » (E14), « Conditions d'utilisation », « Politique de confidentialité ».
* « Se déconnecter » (invité : confirmation « Vous allez perdre vos X jetons. »).
* « Supprimer mon compte » (confirmation en deux étapes, saisie du mot « SUPPRIMER »).

### E14 — Règles du jeu

* Règles en langage simple, illustrées, avec un exemple par carte spéciale (7, As, Valet, Joker, 2) et l'annonce « Check ».
* Section « Options de partie » reprenant R1 à R8.

### E15 — Créer un compte depuis un invité (fenêtre)

* « Gardez vos {solde} jetons et recevez 4 000 jetons de plus. »
* « Continuer avec Google » → liaison d'identité Google, puis `sync_account`.
* « Utiliser un email » → saisie de l'email (envoi du lien de confirmation par Supabase), puis du mot de passe après confirmation. Message : « Confirmez votre email avant de vous déconnecter, sinon vos jetons seront perdus. »
* Erreur `IDENTITY_ALREADY_REGISTERED` : « Ce compte existe déjà. Connectez-vous avec lui (vos jetons d'invité seront perdus). »

---

## 4. Messages transverses

| Situation | Affichage |
| ----- | ----- |
| Erreur d'action | Bandeau court (3 s) en bas de l'écran, texte du code d'erreur |
| Gain de jetons | Animation « +N » qui vole vers le solde de l'en-tête |
| Version obsolète (fermeture 4002) | Fenêtre « Nouvelle version disponible » + bouton « Mettre à jour » (recharge) |
| Autre onglet ouvert (4003) | Plein écran « Cette partie est ouverte dans un autre onglet » |
| Session expirée | Retour à E1 avec « Reconnectez-vous » |
| Invitation à installer l'app | Après la 1ʳᵉ partie terminée, une seule fois : « Ajouter Check à l'écran d'accueil ? » |
