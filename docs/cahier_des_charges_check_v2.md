# Cahier des Charges & Spécifications du Moteur de Jeu — Check (MVP) — v2

Ce document est la référence fonctionnelle et technique unique pour l'implémentation du moteur de jeu de cartes **Check**, dans sa forme camerounaise. Toutes les règles décrites ici sont **normatives** pour la logique serveur. Toute valeur chiffrée est une **clé de configuration** (voir §11).

> **v2 — 19/11/2026.** Révision de la v1 après analyse de l'application *Check Games* (Play Store) et des règles camerounaises usuelles. Les changements et leurs raisons sont listés au §13.
>
> **Mise à jour 19/11/2026 :** règle du Joker corrigée. Le Joker ouvre sa couleur (rouge : ♥ ou ♦ ; noir : ♠ ou ♣) au lieu d'être transparent (§5.4).
>
> **Mise à jour 19/11/2026 (2) :** points en attente validés. Le 2 « passe-partout » devient une option choisie à la création du salon (§2.2, §5.6). Finir sur un As est interdit en duel (§10.1). La pénalité d'oubli du « Check » est confirmée (§8).
>
> **Mise à jour 19/11/2026 (3) :** les 8 règles de l'écran « Règles du jeu » de l'app de référence deviennent des options de partie (§2.2). Ajout des frais de participation en jetons (§2.3).
>
> **Mise à jour 19/11/2026 (4) :** jetons virtuels confirmés, commission de 10 %. Comptes et économie de jetons détaillés dans un document dédié : `specification_comptes_et_jetons.md`.
>
> **Mise à jour 19/11/2026 (5) :** plateforme fixée (application web sur Cloudflare + Supabase). Dossier technique complet : voir `plan_de_developpement.md`.
>
> **Mise à jour 19/11/2026 (6) :** à 2 joueurs, poser sa dernière carte fait gagner **immédiatement**, sauf si c'est un As (§10). La victoire suspendue sur un 7 ou un Joker est supprimée.
>
> **Mise à jour 19/11/2026 (7) :** combinaisons de Jokers, déconnexion hors de son tour, 3ᵉ tour manqué, fermeture de la fenêtre de dénonciation (§5.2, §5.3, §8, §9, décisions 7 à 14 du §14).

---

## 1. Vue d'ensemble & périmètre MVP

* **Nom du jeu :** Check (variante « Check Standard »).
* **Famille :** jeu de défausse (type Crazy Eights / « Huit américain »), joué au Cameroun avec un paquet de 54 cartes.
* **But :** être le premier à se débarrasser de toutes ses cartes.
* **Plateforme :** application **web** installable (PWA), mobile d'abord, hébergée sur **Cloudflare** ; base de données et comptes sur **Supabase** (voir `architecture_technique.md`).
* **Architecture :** multijoueur en ligne, serveur autoritaire (*server-authoritative*), temps réel par WebSocket (voir `protocole_temps_reel.md`).
* **Score :** aucun score cumulé ni classement dans le MVP. Une partie = une manche sèche, victoire directe. (Le mode multi-manches à points est prévu en V2, voir §12.)
* **Enjeu :** chaque partie coûte des frais de participation en jetons virtuels (200 minimum) ; le vainqueur remporte la cagnotte (§2.3).
* **Sens de jeu :** horaire, fixe (aucune carte n'inverse le sens).

---

## 2. Configuration de la partie & salons

| Réf. | Paramètre | Valeur retenue |
| ----- | ----- | ----- |
| **A1** | Variante | **Check Standard (MVP)** |
| **A2** | Joueurs minimum | **2** |
| **A3** | Joueurs maximum | **6** (un seul paquet) |
| **A4** | Types de salon | **Privé** (code d'invitation) et **Public** (matchmaking) |
| **A5** | Rejoindre en cours de partie | **Non autorisé** : la table est verrouillée au lancement |
| **A6** | Durée d'un tour | **30 secondes** (configurable de 15 à 60 s) |
| **A7** | Durée de vie d'un salon en attente | **300 secondes** |
| **A8** | Compte à rebours de lancement (salon public) | **60 secondes**, déclenché à l'arrivée du 2ᵉ joueur |
| **A9** | Options de règles et frais de participation | Choisis par le **créateur du salon** (voir §2.2 et §2.3) |

### 2.1 Règles de lancement

1. **Salon privé :** l'hôte lance la partie manuellement dès que la table compte au moins 2 joueurs.
2. **Salon public :** le compte à rebours de 60 s démarre quand le 2ᵉ joueur arrive. Il n'est pas remis à zéro par les arrivées suivantes.
3. **Table pleine (6 joueurs) :** lancement immédiat, quel que soit le type de salon.
4. **Expiration :** si 300 s après la création la table compte moins de 2 joueurs, le salon est détruit.
5. Si l'hôte d'un salon privé quitte avant le lancement, le rôle d'hôte passe au joueur arrivé le plus tôt.

### 2.2 Options de règles (choisies à la création de la partie)

Reprend l'écran « Règles du jeu » de l'app de référence : une case à cocher par règle. Les libellés de l'écran sont conservés (« piquer » = piocher).

| # | Option (libellé écran) | Clé | Défaut | Activée | Désactivée |
| ----- | ----- | ----- | ----- | ----- | ----- |
| **R1** | Le 2 est transparent | `two_transparent` | ✓ | Le 2 se pose sur toute carte et se glisse dessous (§5.6) | Le 2 est une carte ordinaire |
| **R2** | Le J commande | `jack_commands` | ✓ | Le poseur du Valet annonce la couleur suivante (§5.5) | Pas d'annonce : on joue sur le Valet comme sur une carte ordinaire (son enseigne, ou un autre Valet) |
| **R3** | Le J passe partout | `jack_wild` | ✓ | Le Valet se pose sur n'importe quelle carte | Le Valet suit la règle standard (même enseigne ou même valeur) |
| **R4** | L'As stoppe le joueur suivant | `ace_skips` | ✓ | Le joueur suivant saute son tour (§6) | L'As est une carte ordinaire |
| **R5** | Le 7 fait piquer 2 cartes | `seven_draw_two` | ✓ | +2, cumulable (§6.1) | Le 7 est une carte ordinaire et ne contre pas |
| **R6** | Le Joker fait piquer 4 cartes | `joker_draw_four` | ✓ | +4, cumulable (§6.1) | Le Joker ne fait rien piocher et ne contre pas ; il garde son effet de couleur (§5.4) |
| **R7** | Le Joker passe partout | `joker_wild` | ✓ | Le Joker se pose sur n'importe quelle carte | Le Joker se pose selon sa couleur (§5.4) |
| **R8** | Les cartes de même valeur peuvent être doublées | `allow_multiples` | ✓ | Combinaisons autorisées (§5.3) | Une seule carte par tour, y compris en contre ; combinaison 7 + Joker interdite |

**Règles de cohérence (appliquées par le serveur) :**

* Avec R2 et R3 désactivés, le Valet est une carte ordinaire.
* Seules les cartes dont l'effet de pioche est activé (R5, R6) peuvent contrer. Si R5 et R6 sont tous deux désactivés, il n'y a plus de pénalité dans la partie.
* La pose d'un Joker « sur un 7 » (§5.4) n'existe que si R5 et R6 sont tous deux activés.
* La combinaison 7 + Joker (§5.3) n'existe que si R6 est activé ; si R5 est désactivé, le 7 doit être de la couleur d'un des Jokers posés.
* Carte de départ (B5) : une carte est « spéciale » si son effet est activé. Le Joker l'est toujours (effet de couleur).
* Interdiction de finir sur un As à 2 joueurs (§10.1) : uniquement si R4 est activé.
* Quelles que soient les options, le Valet et le 2 transparent restent interdits sous pénalité.

**Fonctionnement :**

* Le créateur du salon (privé ou public) fixe les options à la création (envoyées dans `POST /api/rooms` et validées par le serveur).
* Les options sont **affichées dans la liste des salons et dans la salle d'attente**. La liste des salons publics met en évidence les options qui diffèrent des valeurs par défaut.
* L'hôte peut les modifier tant que la partie n'est pas lancée ; chaque modification est notifiée aux joueurs présents.
* Elles sont **verrouillées au lancement** et ne changent plus jusqu'à la fin de la partie.

### 2.3 Frais de participation

Reprend le réglage « Frais de participation » de l'écran « Créer une partie » (boutons − / +). **La spécification complète est dans `specification_comptes_et_jetons.md`**, qui fait foi. Résumé :

* **Jetons virtuels** sans valeur monétaire : ni achat, ni retrait, ni transfert entre joueurs.
* **Montant :** de **200 (minimum)** à 10 000 par paliers de 100, 200 par défaut, choisi par le créateur. Pas de partie gratuite.
* **Débit au lancement** de la partie, pas à l'entrée dans le salon.
* **Cagnotte** = frais × joueurs au lancement. Le vainqueur (y compris par forfait) la remporte, **moins 10 % de commission**.
* **Abandon ou forfait :** frais perdus. **Partie nulle ou annulée :** remboursement intégral, sans commission.
* **Jetons de départ :** 5 000 pour un compte Google ou Email, 1 000 pour un invité (perdus à la déconnexion). **Bonus quotidien** de 400 pour les comptes inscrits.

---

## 3. Paquet, distribution & initialisation

| Réf. | Paramètre | Spécification |
| ----- | ----- | ----- |
| **B1** | Composition | **54 cartes** : 52 cartes (Cœur ♥, Carreau ♦, Pique ♠, Trèfle ♣ ; de l'As au Roi) + **2 Jokers** : **1 Joker rouge** et **1 Joker noir** |
| **B2** | Couleur (rouge/noir) | Rouges : ♥ ♦ et Joker rouge. Noires : ♠ ♣ et Joker noir |
| **B3** | Main initiale | **5 cartes** par joueur |
| **B4** | Distribution | Une carte à la fois, dans le sens horaire |
| **B5** | Carte de départ | Première carte de la pioche retournée. **Si c'est une carte spéciale (le Joker, ou un 7, un As, un Valet ou un 2 dont l'effet est activé dans les options, §2.2), elle est remise dans la pioche, la pioche est rebattue, et on retourne une nouvelle carte.** On répète jusqu'à obtenir une carte ordinaire |
| **B6** | Aléatoire | Mélange et tirages par **CSPRNG**, exclusivement côté serveur |
| **B7** | Premier joueur | Tiré au sort parmi les joueurs de la table |

---

## 4. Vocabulaire du moteur

* **Talon :** pile de défausse. Sa carte du dessus est la **carte visible**.
* **Carte de référence :** la carte visible, à laquelle on doit correspondre.
* **Couleur ouverte (rouge/noir) :** quand la carte visible est un Joker, on ne joue plus sur une enseigne précise mais sur **les deux enseignes de la couleur du Joker** (voir §5.4).
* **Couleur demandée :** couleur (enseigne) imposée par un Valet. Elle remplace l'enseigne de la carte de référence jusqu'à la carte suivante.
* **Pénalité active :** compteur de cartes à piocher (> 0) visant le joueur dont c'est le tour.
* **Joueurs actifs (N) :** joueurs encore en jeu à l'instant considéré (hors abandons et forfaits). Toutes les règles qui dépendent du nombre de joueurs utilisent **N actuel**, pas le nombre au départ.

---

## 5. Règles de pose

### 5.1 Pose standard (sans pénalité active)

Une carte est jouable si elle respecte au moins une condition :

* **même valeur** que la carte de référence ;
* **même enseigne** que la carte de référence, ou que la couleur demandée si un Valet est actif ;
* si la carte visible est un **Joker** : n'importe quelle carte **de la couleur du Joker** (♥ ou ♦ après un Joker rouge, ♠ ou ♣ après un Joker noir) ;
* c'est un **Valet** et l'option R3 « Le J passe partout » est activée ;
* c'est un **2** et l'option R1 « Le 2 est transparent » est activée (§5.6) ;
* c'est un **Joker** et l'option R7 « Le Joker passe partout » est activée, ou les conditions du §5.4 sont remplies.

### 5.2 Pose sous pénalité active

Le joueur visé n'a que deux options :

1. **Contrer** en posant un ou plusieurs **7** et/ou **Jokers** dont l'effet de pioche est activé (R5, R6), **sans condition d'enseigne ni de couleur**. Si R8 est désactivé, le contre se fait avec une seule carte ;
2. **Encaisser** : piocher la totalité de la pénalité (§6.2).

Aucune autre carte ne peut être jouée sous pénalité, **ni le Valet, ni l'As, ni le 2 transparent**. Chaque carte d'un contre doit elle-même pouvoir contrer : si R5 est désactivé, le 7 est une carte ordinaire et ne peut pas accompagner un Joker en contre (le contre se limite aux Jokers).

### 5.3 Combinaisons (plusieurs cartes en un tour)

Uniquement si l'option R8 « Les cartes de même valeur peuvent être doublées » est activée. Sinon, une seule carte par tour.

| Combinaison | Règle |
| ----- | ----- |
| **Même valeur** | Plusieurs cartes de même valeur (ex. trois 8). **La première carte posée doit être jouable** ; les suivantes doivent seulement avoir la même valeur |
| **7 + Joker** | Un ou plusieurs 7 et un ou plusieurs Jokers peuvent être posés ensemble. Hors pénalité, la première carte doit être jouable. **Impossible si R6 est désactivé** (le Joker sans effet de pioche ne se combine pas avec un 7). **Si R5 est désactivé**, le 7 est une carte ordinaire : la combinaison n'est possible que si la couleur du 7 (rouge/noir) est celle d'un des Jokers posés, et seul le Joker fait piocher (+4), pas le 7 |
| **Deux Jokers** | Les deux Jokers (`XR` + `XB`) peuvent être posés ensemble, avec ou sans 7. Hors pénalité, la première carte doit être jouable. La couleur ouverte est celle du dernier Joker posé. Permis aussi si R6 est désactivé : aucune pénalité, la couleur du dernier Joker est ouverte |
| **Interdit** | Mélanger des valeurs différentes (sauf 7 + Joker) |

**Ordre de pose :** le client envoie la liste **ordonnée** des cartes. La dernière carte de la liste devient la carte visible. L'ordre n'a aucune incidence sur le total de pénalité, mais il fixe la référence pour le joueur suivant.

**Effets cumulés :**

* **7 :** +2 par 7 posé. **Joker :** +4 par Joker posé.
* **As :** chaque As fait sauter un joueur (2 As = 2 joueurs sautés). Si le saut revient sur le poseur, celui-ci rejoue.
* **Valet :** plusieurs Valets peuvent être posés ensemble ; le joueur annonce **une seule** couleur.

### 5.4 Le Joker

* **Option R7 « Le Joker passe partout » activée :** le Joker se pose sur **n'importe quelle carte** hors pénalité.
* **Option R7 désactivée — jouable hors pénalité si :**
  * la carte visible est un **Joker**, ou la carte de référence est un **7** (cette dernière condition seulement si R5 et R6 sont activés) ; **ou**
  * la couleur du Joker (rouge/noir) correspond à celle de l'enseigne de référence (ou de la couleur demandée). Exemple : le Joker rouge se pose sur ♥ ou ♦.
* **Jouable sous pénalité :** toujours en contre (§5.2), si R6 est activé.
* **Changement de couleur :** le Joker ouvre **sa** couleur. Une fois sa pénalité résolue, le joueur suivant peut poser **n'importe quelle carte des deux enseignes de cette couleur**, un Valet ou l'autre Joker.
  * *Exemple :* Joker rouge posé sur un 5♦. Le joueur suivant encaisse les 4 cartes. Le joueur d'après peut jouer un **carreau ou un cœur** (ou un Valet, ou le Joker noir).
  * Même principe pour le Joker noir : **pique ou trèfle**.
  * La couleur ouverte est celle **du Joker**, pas celle de la carte posée dessous : un Joker noir posé en contre sur un 7♦ ouvre pique et trèfle.
  * Le Joker n'ayant pas de valeur, on ne peut pas jouer « à la valeur » sur lui (le 5♠ ne se pose pas sur un Joker rouge posé sur un 5♦).

### 5.5 Le Valet

Deux options indépendantes régissent le Valet (§2.2) :

* **R3 « Le J passe partout » :** activée, le Valet se pose sur **n'importe quelle carte** ; désactivée, il suit la règle standard (même enseigne ou même valeur).
* **R2 « Le J commande » :** activée, le poseur **doit annoncer une couleur** (♥ ♦ ♠ ♣), y compris celle de la carte de référence. Le joueur suivant doit jouer la couleur demandée, un autre Valet, ou un Joker de la couleur correspondante (ou tout Joker si R7 est activée). Sinon, il pioche. Désactivée, le Valet ne change pas la couleur.
* Dans tous les cas, le Valet est interdit sous pénalité active.

### 5.6 Le 2 transparent (option R1)

Règle active **uniquement si l'option R1 « Le 2 est transparent » est cochée** (§2.2). Sinon, le 2 est une carte ordinaire.

* **Pose :** le 2 se pose sur **n'importe quelle carte**, hors pénalité active.
* **Effet :** il se **glisse sous la carte visible**. La carte visible ne change pas, ni la couleur demandée par un Valet, ni la couleur ouverte par un Joker. Le joueur suivant joue sur la même carte que si le 2 n'avait pas été posé.
* **Pas de réactivation :** la carte visible ne rejoue pas son effet. Un 7 ou un Joker déjà encaissé ne redonne pas de pénalité, un As ne refait pas sauter de tour.
* **Sous pénalité :** interdit. Le 2 n'est pas un contre.
* **Combinaison :** plusieurs 2 peuvent être posés ensemble ; ils se glissent tous sous la carte visible.
* **Fin de partie :** finir sur un 2 est autorisé (victoire immédiate).

---

## 6. Cartes spéciales, pénalités & chaînage

| Carte | Effet | Contrable ? |
| ----- | ----- | ----- |
| **7** | Le joueur suivant pioche **2 cartes** | Oui, par un 7 ou un Joker |
| **Joker** | Le joueur suivant pioche **4 cartes** | Oui, par un 7 ou un Joker |
| **As** | Le joueur suivant **saute son tour**. À 2 joueurs, le poseur rejoue | Non |
| **Valet** | **Changement de couleur** au choix du poseur | — (interdit sous pénalité) |

Chaque effet ne s'applique que si l'option correspondante est cochée (R2 à R6, §2.2). Désactivé, la carte se joue comme une carte ordinaire.

### 6.1 Cumul (*penalty stack*)

1. Chaque 7 ajoute +2 et chaque Joker +4 au compteur global.
2. Le joueur visé peut contrer (§5.2) : les valeurs s'additionnent et la pénalité passe au joueur suivant (2+2 = 4, 2+4 = 6, 4+4 = 8…).
3. Le compteur revient à 0 dès que la pénalité est encaissée.

### 6.2 Encaissement

* Le joueur qui ne peut pas ou ne veut pas contrer **pioche toutes les cartes accumulées**.
* Il **perd son tour** : il ne pose rien après avoir encaissé.
* La carte visible (7 ou Joker) reste en place. Le joueur suivant joue sans pénalité : sur un 7, selon la règle standard ; sur un Joker, dans la couleur ouverte par le Joker (§5.4).

---

## 7. Déroulement du tour & pioche

### 7.1 Actions possibles à son tour

| Situation | Actions autorisées |
| ----- | ----- |
| Pas de pénalité | `PLAY` (une carte ou une combinaison) **ou** `DRAW` (pioche 1 carte) |
| Pénalité active | `PLAY` (contre avec 7/Joker) **ou** `DRAW` (encaisse toute la pénalité) |

### 7.2 Pioche simple

* Un joueur qui ne peut pas ou ne veut pas jouer pioche **1 carte**.
* **La pioche termine le tour**, même si la carte piochée est jouable (règle de l'app *Check Games* et usage courant). L'action `PASS` n'existe donc pas.

### 7.3 Expiration du tour (timeout)

À l'expiration du temps, le serveur joue automatiquement à la place du joueur :

* **sans pénalité :** pioche d'1 carte, puis le tour passe ;
* **avec pénalité active :** pioche de **toute** la pénalité, puis le tour passe.

Un joueur qui atteint **3 timeouts consécutifs** est déclaré **forfait** (§9).

### 7.4 Épuisement de la pioche

1. Quand la pioche est vide, le talon est mélangé pour reformer la pioche, à l'exception de la carte visible, qui reste sur la table.
2. S'il n'y a toujours pas assez de cartes pour honorer une pioche, le joueur pioche ce qui est disponible et **le reste est annulé**.
3. **Blocage :** si la pioche et le talon sont épuisés et qu'un tour de table complet se passe sans qu'aucune carte soit posée, la partie s'arrête. Le joueur qui a le moins de cartes gagne ; en cas d'égalité, la partie est déclarée **nulle**.

---

## 8. L'annonce « Check ! »

C'est l'annonce qui donne son nom au jeu.

* Un joueur qui, **en posant**, se retrouve avec **une seule carte** en main doit annoncer **« Check ! »**. Côté client, c'est le bouton **CHECK**, envoyé avec l'action de pose (`declareCheck: true`).
* **Oubli :** jusqu'à la prochaine action valide (du joueur suivant, ou du même joueur s'il rejoue après un As), n'importe quel adversaire peut appuyer sur **« Dénoncer »** (`CALL_CHECK`). Le premier à dénoncer fait piocher **2 cartes** au fautif. Cette pénalité ne peut pas être contrée et ne fait pas perdre de tour.
* La fenêtre se ferme à la prochaine pose, pioche ou action automatique. L'abandon ou le forfait d'un **autre** joueur ne la ferme pas ; celui du **fautif** la ferme.
* Sans dénonciation dans ce délai, l'oubli n'est plus sanctionnable.
* Pas d'annonce requise si le joueur passe directement à 0 carte (combinaison finale).
* **Option de configuration :** `check_call.mode = "denunciation"` (par défaut) ou `"automatic"` (pénalité appliquée d'office par le serveur, utile contre des bots ou pour les débutants).

---

## 9. Déconnexions, abandons & forfaits

| Événement | Traitement moteur |
| ----- | ----- |
| **Déconnexion pendant son tour** | Le chrono du tour est prolongé jusqu'à **60 s au total** pour laisser le temps de se reconnecter. Sans reconnexion, le serveur applique l'action automatique du §7.3 |
| **Déconnexion pendant le tour d'un autre joueur** | Quand son tour arrive, le serveur joue l'action automatique **immédiatement**, sans délai de grâce |
| **Tours suivants, toujours déconnecté** | Le serveur joue l'action automatique **immédiatement**, sans attendre |
| **3 tours manqués consécutifs** (timeouts ou déconnexion) | La 3ᵉ action automatique (pioche) est **appliquée**, puis le joueur est déclaré **forfait** et traité comme un abandon. Toute action volontaire (pose **ou pioche**) remet le compteur à 0 |
| **Abandon volontaire / forfait** | Le joueur est retiré de la rotation. Ses cartes sont **glissées sous la pioche** (jamais sur le talon, pour ne pas changer la carte visible). **Une pénalité qui le visait est annulée** et le tour passe au joueur suivant, qui joue sans pénalité |
| **Dernier joueur restant** | Il est **immédiatement proclamé vainqueur par forfait** |

Un joueur reconnecté reprend sa place et sa main.

---

## 10. Conditions de victoire

### 10.1 Victoire normale

Le premier joueur dont la main atteint **0 carte** gagne **immédiatement**, quel que soit le nombre de joueurs. **Seule exception : l'As à 2 joueurs.**

| Dernière carte | N > 2 | N = 2 (duel) |
| ----- | ----- | ----- |
| Carte ordinaire, 2 transparent | Victoire immédiate | Victoire immédiate |
| **Valet** | Victoire immédiate (aucune couleur à annoncer) | Victoire immédiate |
| **7 ou Joker** | Victoire immédiate (§10.2) | Victoire immédiate (§10.2) |
| **As** | Victoire immédiate | **Interdit** si R4 est activé ; sinon victoire immédiate |

**As en duel :** quand il ne reste que 2 joueurs actifs, le serveur **refuse** toute pose qui viderait la main avec un ou plusieurs As. Le joueur dont la dernière carte est un As doit donc piocher. Il peut en revanche poser un As quand il lui reste au moins une autre carte : il rejoue alors immédiatement (effet de l'As à 2 joueurs) et peut finir avec sa dernière carte si elle est jouable. N se compte **au moment de la pose** : si un abandon fait passer la table de 3 à 2 joueurs, l'interdiction s'applique aussitôt.

### 10.2 Finir sur un 7 ou un Joker

La victoire est **immédiate**, à 2 joueurs comme à plus de 2, dès la pose de la dernière carte. La partie s'arrête : la pénalité du 7 ou du Joker n'est pas appliquée, le joueur suivant ne pioche pas et ne peut pas contrer.

---

## 11. Directives d'architecture serveur

### 11.1 Validation stricte

Le client ne calcule aucune légalité. Toute action (`POST /api/rooms`, `UPDATE_OPTIONS`, `PLAY`, `DRAW`, `CALL_CHECK`, `LEAVE`) est validée par le serveur avant diffusion du nouvel état. Une action invalide est rejetée avec un code d'erreur et ne consomme pas le tour.

### 11.2 Données envoyées à chaque client (anti-triche)

Chaque client reçoit **uniquement** :

* les identifiants des cartes de **sa propre main** ;
* la carte visible (si c'est un Joker, sa couleur indique les enseignes jouables) ;
* la couleur demandée (après un Valet) ;
* les options de règles du salon (R1 à R8) et le montant des frais de participation ;
* le compteur de pénalité active ;
* le joueur dont c'est le tour et le temps restant ;
* pour chaque adversaire : pseudo, **nombre de cartes**, statut de connexion, annonce « Check » faite ou non ;
* la taille de la pioche.

Le contenu de la pioche et les mains adverses ne quittent jamais le serveur.

### 11.3 Configuration centralisée

Toutes les constantes de jeu sont chargées depuis un fichier unique du Worker (`apps/worker/src/game_config.ts`). **Le serveur refuse de démarrer si une clé manque.** Les noms des messages (`PLAY`, `DRAW`, `CALL_CHECK`…) et leur contenu exact sont définis dans `protocole_temps_reel.md`.

| Clé | Valeur MVP |
| ----- | ----- |
| `players.min` / `players.max` | 2 / 6 |
| `hand.initial_size` | 5 |
| `timers.turn_seconds` | 30 |
| `timers.disconnect_grace_seconds` | 60 |
| `timers.room_ttl_seconds` | 300 |
| `timers.public_start_countdown_seconds` | 60 |
| `timers.game_max_duration_seconds` | 7200 (partie annulée et remboursée au-delà, protocole §9) |
| `timers.finished_room_close_seconds` | 60 (fermeture du salon après la fin de partie, protocole §9) |
| `afk.max_consecutive_missed_turns` | 3 |
| `penalty.seven` / `penalty.joker` | 2 / 4 |
| `ace.combo_cumulative` | true |
| `check_call.enabled` / `check_call.penalty` / `check_call.mode` | true / 2 / "denunciation" |
| `win.forbid_finish_on_ace_in_duel` | true (si R4 activé) |
| `room_options.defaults` (R1 à R8) | toutes à true (modifiables par le créateur du salon, §2.2) |
| `economy.*`, `fees.*`, `guest.*`, `auth.*` | Voir `specification_comptes_et_jetons.md`, §12 |

---

## 12. Hors périmètre MVP (feuille de route V2)

* **Mode multi-manches à points :** le gagnant marque les points des cartes restant dans les mains adverses (proposé par *Check Games*).
* **7 à 9 joueurs** avec deux paquets mélangés.
* **Autres options de salon** sur le même modèle (ex. mode de l'annonce « Check », durée du tour).
* **Jetons gagnés en regardant des publicités** (voir `specification_comptes_et_jetons.md`, §13).
* Partie contre l'ordinateur (bots), chat rapide, classement.

---

## 13. Changements par rapport à la v1

| # | v1 | v2 | Raison |
| ----- | ----- | ----- | ----- |
| 1 | Joker « doit correspondre à la couleur active » (règle inapplicable, le Joker n'a pas d'enseigne) | Joker rouge / Joker noir, jouable sur sa couleur, sur un 7, sur un Joker ; il **ouvre sa couleur** ensuite (les deux enseignes) | Règle applicable, validée par le porteur du projet |
| 2 | Timeout : pioche d'1 carte, même sous pénalité | Sous pénalité, le timeout fait encaisser toute la pénalité | Supprime la contradiction avec le §5.1 de la v1 et un exploit (attendre le timeout pour ne piocher qu'une carte) |
| 3 | Contre : condition d'enseigne floue | Le contre se fait avec tout 7 ou Joker, sans condition | Clarification |
| 4 | Pioche puis « fin de tour ou pose » (flou) | La pioche termine le tour ; `PASS` supprimé | Règle de l'app *Check Games* et usage courant ; plus simple à coder |
| 5 | Pas d'annonce | Annonce « Check ! » + dénonciation (+2) | Règle de l'app *Check Games* (où elle est optionnelle) ; c'est le cœur du nom du jeu |
| 6 | Combos d'As et de Valets non définis | As cumulatifs, Valets multiples avec une seule couleur, ordre de pose = carte visible | Trous comblés |
| 7 | As interdit sous pénalité : non précisé | Interdit explicitement | Clarification |
| 8 | Déconnecté « gelé 60 s à chaque tour », sans limite | Grâce de 60 s, puis actions automatiques, forfait après 3 tours manqués | Évite les parties bloquées |
| 9 | Cartes d'un abandon « défaussées/retirées » | Glissées sous la pioche ; pénalité visant l'abandonnant annulée | Ne modifie pas la carte visible ; cas tranché |
| 10 | Pioche et talon vides : non traité | Pioche partielle, règle de blocage | Cas limite à 6 joueurs |
| 11 | Victoire sur un 7 ou un Joker suspendue en duel ; N ambigu | Victoire immédiate à 2 comme à plus de 2 joueurs ; N = joueurs actifs au moment de la pose (règle de l'As) | Décision du porteur du projet |
| 12 | Tour de 60 s | 30 s (configurable) | 60 s × 6 joueurs rend la partie lente sur mobile |
| 13 | Lancement uniquement automatique après 300 s | Lancement manuel (privé), compte à rebours de 60 s (public), lancement immédiat à table pleine | Une table pleine n'attend plus 5 minutes |
| 14 | Liste anti-triche incomplète | Ajout de la couleur demandée, de la pénalité, du tour, du chrono, des statuts | Informations indispensables à l'interface |
| 15 | Le 2 : carte ordinaire | Le 2 « transparent » est une **option choisie à la création du salon** (R1) | Décision du porteur du projet : les tables camerounaises ne jouent pas toutes le 2 de la même façon |
| 16 | Finir sur un As : non traité | Interdit en duel, autorisé à partir de 3 joueurs | Décision du porteur du projet |
| 17 | — | Oubli du « Check » : +2 sur dénonciation | Décision du porteur du projet |
| 18 | Règles fixes | 8 options de partie reprises de l'écran « Règles du jeu » de l'app de référence (R1 à R8), toutes cochées par défaut | Décision du porteur du projet |
| 19 | — | Frais de participation en jetons virtuels, cagnotte au vainqueur moins 10 % de commission ; comptes et jetons détaillés dans un document dédié | Repris de l'écran « Créer une partie » de l'app de référence ; décisions du porteur du projet |

---

## 14. Décisions validées par le porteur du projet (19/11/2026)

1. **Joker rouge / noir :** le Joker ouvre sa couleur, les deux enseignes (§5.4). La couleur ouverte est celle du Joker, et on ne joue pas à la valeur sur un Joker.
2. **Le 2 :** « transparent » en option, choisie à la création du salon (§2.2, §5.6).
3. **Fin de partie :** poser sa dernière carte fait gagner immédiatement, quels que soient la carte (7 et Joker compris) et le nombre de joueurs, **sauf l'As à 2 joueurs**, qui est interdit (§10).
4. **Oubli du « Check » :** +2 cartes, sur dénonciation par un adversaire (§8).
5. **Options de partie :** les 8 règles de l'écran « Règles du jeu » sont réglables à la création de la partie (§2.2).

6. **Frais de participation :** jetons virtuels ; 5 000 jetons à l'inscription (Google, Email), 1 000 pour un invité, perdus à sa déconnexion ; parties à 200 jetons minimum ; bonus quotidien de 400 ; commission de 10 % ; gains par publicité après le MVP (§2.3 et `specification_comptes_et_jetons.md`).

7. **Combinaisons de Jokers :** les deux Jokers peuvent être posés ensemble ; la combinaison 7 + Joker est impossible si R6 est désactivé (§5.3).
8. **Déconnexion pendant le tour d'un autre :** action automatique immédiate quand son tour arrive (§9).
9. **3ᵉ tour manqué :** la pioche automatique est appliquée avant le forfait ; une pioche volontaire remet le compteur de tours manqués à 0 (§9).
10. **Fenêtre de dénonciation :** fermée par la prochaine pose, pioche ou action automatique, ou par l'abandon du fautif (§8).

11. **Cartes d'un joueur forfait :** confirmées sous la pioche, pour tout abandon ou forfait (§9).
12. **7 + Joker avec R5 désactivé :** possible seulement si le 7 est de la couleur d'un des Jokers posés ; seul le Joker fait piocher (§5.3).
13. **Deux Jokers avec R6 désactivé :** permis, sans pénalité, couleur du dernier Joker ouverte (§5.3).
14. **Contre avec R5 désactivé :** limité aux Jokers ; un 7 (carte ordinaire) ne peut pas accompagner le Joker sous pénalité (§5.2).

---

### Sources consultées

* *Check Games: African card game*, Google Play (règles publiées dans la description de l'app) : https://play.google.com/store/apps/details?id=com.doferlo.check_games
* *Check Games* (ADDcoded, Douala) — fiche Google Play : https://play.google.com/store/apps/details?id=com.asogboudiffouodropacode.check_games
* *check-game* (GitHub, implémentation communautaire du « Chek-games ») : https://github.com/ruhtra74/check-game
* Pagat — *Card games in Cameroon* : https://www.pagat.com/national/cameroon.html
