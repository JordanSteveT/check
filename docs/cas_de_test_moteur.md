# Cas de test du moteur de règles — Check

Chaque ligne est un test automatisé à écrire dans `packages/engine/test/` (Vitest). Le moteur doit passer **100 %** de ces tests avant tout branchement au serveur. Les règles de référence sont dans `cahier_des_charges_check_v2.md` ; l'interface du moteur dans `protocole_temps_reel.md` §12.

> **Version 1.0 — 19/11/2026.**
>
> **Version 1.1 — 19/11/2026.** Tests W3, W4, W5, W11 et W14 réécrits : à 2 joueurs, poser sa dernière carte fait gagner immédiatement, sauf l'As.
>
> **Version 1.2 — 19/11/2026.** Ajout de C14 à C20, R11, CH12, CH13, F9 ; R5 précisé (décisions 7 à 14 du cahier des charges §14).

---

## Conventions

* **Joueurs** : A, B, C, D dans le sens horaire. Sauf mention contraire : 3 joueurs (A, B, C), c'est le tour de A.
* **Cartes** : codage du protocole (`5H` = 5 de cœur, `JS` = Valet de pique, `XR` / `XB` = Joker rouge / noir).
* **État** : `talon` = carte visible ; `dem` = couleur demandée (Valet) ; `ouv` = couleur ouverte (Joker) ; `pén` = pénalité active.
* **Options** : toutes cochées (R1 à R8) sauf mention contraire.
* **Résultat** : « OK » = coup accepté ; sinon le **code d'erreur** attendu.
* Les tests construisent l'état directement (fonction utilitaire `makeState`), sans passer par une distribution aléatoire, sauf section I.
* Chronomètre : `now` fixé ; durée de tour 30 s.

---

## I. Initialisation

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| I1 | 2 joueurs | `createGame` | 5 cartes par main, 1 au talon, 43 dans la pioche ; 54 cartes uniques au total |
| I2 | 6 joueurs | `createGame` | 30 cartes en main, 1 au talon, 23 dans la pioche |
| I3 | Générateur réglé pour que la 1ʳᵉ carte retournée soit `7H` | `createGame` | `7H` remise dans la pioche, nouvelle carte retournée ; le talon n'est jamais 7, As, Valet, Joker ou 2 |
| I4 | R1 décochée, générateur donnant `2S` en premier | `createGame` | `2S` accepté comme carte de départ |
| I5 | R4 décochée, générateur donnant `AH` en premier | `createGame` | `AH` accepté comme carte de départ |
| I6 | Même graine, mêmes joueurs | `createGame` deux fois | États strictement identiques (déterminisme) |
| I7 | 1 000 parties à graines différentes, 4 joueurs | `createGame` | Chaque joueur commence au moins une fois (premier joueur aléatoire) |
| I8 | Nouvelle partie | — | `pén` = 0, `dem` = null, `ouv` = null, `turnDeadline` = now + 30 s |

## P. Pose standard

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| P1 | talon `5H` | A joue `9H` | OK (même enseigne), tour de B |
| P2 | talon `5H` | A joue `5S` | OK (même valeur) |
| P3 | talon `5H` | A joue `9S` | `ILLEGAL_PLAY` |
| P4 | A n'a pas `9H` | A joue `9H` | `CARD_NOT_IN_HAND` |
| P5 | tour de A | B joue une carte | `NOT_YOUR_TURN` |
| P6 | talon `KH` | A joue `QH` | OK ; Dame et Roi sans effet |
| P7 | talon `7S` déjà encaissé (`pén` 0) | A joue `3S` | OK, aucune pénalité |
| P8 | talon `7S` déjà encaissé | A joue `7H` | OK (valeur), nouvelle `pén` 2 pour B |
| P9 | coup valide de A | — | `turnDeadline` = now + 30 s pour B ; événement `CARDS_PLAYED` émis |

## V. Valet (R2 « commande », R3 « passe partout »)

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| V1 | talon `5H` | A joue `JS`, couleur `D` | OK, `dem` = D, tour de B |
| V2 | talon `5H` | A joue `JS` sans couleur | `SUIT_REQUIRED` |
| V3 | `dem` D (talon `JS`) | B joue `9D` | OK, `dem` effacée |
| V4 | `dem` D (talon `JS`) | B joue `9S` | `ILLEGAL_PLAY` (la couleur demandée remplace l'enseigne du Valet) |
| V5 | `dem` D | B joue `JH`, couleur `C` | OK, `dem` = C |
| V6 | `dem` D, R7 cochée | B joue `XB` | OK |
| V7 | `dem` D, R7 décochée | B joue `XR` / `XB` | `XR` : OK (rouge = carreau) ; `XB` : `ILLEGAL_PLAY` |
| V8 | `pén` 2 | B joue `JC` | `MUST_COUNTER_OR_DRAW` |
| V9 | talon `5S` | A joue `JS`, couleur `S` | OK, `dem` = S (annoncer la même couleur est permis) |
| V10 | talon `XR` encaissé (`ouv` R) | A joue `JS`, couleur `C` | OK, `ouv` effacée, `dem` = C |
| V11 | R2 décochée, R3 cochée, talon `5H` | A joue `JS` sans couleur | OK ; B doit jouer pique ou un Valet |
| V12 | R2 cochée, R3 décochée, talon `5H` | A joue `JS` | `ILLEGAL_PLAY` ; sur talon `5S` : OK et couleur obligatoire |
| V13 | R2 et R3 décochées, talon `5S` | A joue `JS` sans couleur | OK, carte ordinaire |

## J. Joker (R6 « piquer 4 », R7 « passe partout »)

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| J1 | talon `5S` | A joue `XR` | OK, `pén` 4 pour B, `ouv` R |
| J2 | R7 décochée, talon `5S` | A joue `XR` | `ILLEGAL_PLAY` ; sur talon `5H` : OK |
| J3 | R7 décochée, talon `7S` encaissé | A joue `XR` | OK (Joker sur un 7) |
| J4 | R7 décochée, R5 décochée, talon `7S` | A joue `XR` | `ILLEGAL_PLAY` (règle « sur un 7 » inactive) |
| J5 | R7 décochée, talon `XB` encaissé | A joue `XR` | OK (Joker sur Joker) |
| J6 | talon `XR` encaissé (`ouv` R) | A joue `9D`, `9H`, `9S` | `9D` OK ; `9H` OK ; `9S` `ILLEGAL_PLAY` |
| J7 | talon `XR` posé sur `5D`, encaissé | A joue `5S` | `ILLEGAL_PLAY` (pas de jeu à la valeur sur un Joker) |
| J8 | `pén` 2 (talon `7D`) | B joue `XB` | OK (contre sans condition), `pén` 6 pour C, `ouv` B |
| J9 | suite de J8 : C encaisse | — | C reçoit 6 cartes ; tour de A ; A peut jouer pique ou trèfle, pas cœur |
| J10 | `dem` C, R7 décochée | A joue `XB` / `XR` | `XB` OK ; `XR` `ILLEGAL_PLAY` |
| J11 | R6 décochée, talon `5H` | A joue `XR` | OK, `pén` reste 0, `ouv` R, B joue normalement |

## D. Le 2 transparent (R1)

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| D1 | talon `9S` | A joue `2H` | OK ; talon visible reste `9S` ; B peut jouer `4S` |
| D2 | `dem` D | A joue `2C` | OK, `dem` reste D |
| D3 | talon `XR` encaissé (`ouv` R) | A joue `2S` | OK, `ouv` reste R |
| D4 | `pén` 2 | A joue `2H` | `MUST_COUNTER_OR_DRAW` |
| D5 | talon `7H` encaissé (`pén` 0) | A joue `2S` | OK, aucune nouvelle pénalité pour B |
| D6 | talon `AH` (effet déjà appliqué) | A joue `2D` | OK, B n'est pas sauté |
| D7 | talon `9S` | A joue `[2H, 2S]` | OK, talon visible reste `9S` |
| D8 | R1 décochée, talon `9S` | A joue `2H` | `ILLEGAL_PLAY` ; sur talon `9H` : OK et la carte visible devient `2H` |
| D9 | A n'a plus que `2H` | A joue `2H` | Victoire de A |

## A. As (R4)

Formule du joueur suivant : `suivant = siège (i + 1 + k) mod N`, où `i` est le siège du poseur, `k` le nombre d'As posés et `N` le nombre de joueurs actifs.

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| A1 | 3 joueurs, talon `5H` | A joue `AH` | OK, `skipped` = [B], tour de C |
| A2 | 2 joueurs | A joue `AH` | OK, B sauté, A rejoue avec un nouveau `turnDeadline` |
| A3 | 4 joueurs (A, B, C, D) | A joue `[AH, AS]` | B et C sautés, tour de D |
| A4 | 3 joueurs | A joue `[AH, AS]` | B et C sautés, A rejoue |
| A5 | 3 joueurs | A joue `[AH, AS, AD]` | Tour de B (formule) |
| A6 | `pén` 2 | A joue `AS` | `MUST_COUNTER_OR_DRAW` |
| A7 | R4 décochée, talon `5H` | A joue `AH` | OK, aucun saut, tour de B |
| A8 | 4 joueurs, C a abandonné | A joue `AH` | B sauté, tour de D (les joueurs sortis ne comptent pas) |

## K. Pénalités et cumul (R5, R6)

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| K1 | talon `5H` | A joue `7H` | `pén` 2, tour de B |
| K2 | suite de K1 | B `DRAW` | B reçoit 2 cartes, `pén` 0, tour de C (B ne pose rien) |
| K3 | suite de K1 | B joue `7S` | `pén` 4, tour de C |
| K4 | suite de K1 | B joue `XR` | `pén` 6, tour de C |
| K5 | A `7H`, B `XB`, C `7D` | A `DRAW` | A reçoit 8 cartes |
| K6 | `pén` 4 | B joue `9H` | `MUST_COUNTER_OR_DRAW` |
| K7 | talon `XR`, `pén` 4 | B joue `7C` | OK (contre sans condition d'enseigne), `pén` 6 |
| K8 | talon `7H` encaissé | C joue `7S` | OK, nouvelle `pén` 2 pour A |
| K9 | R5 décochée, talon `5H` | A joue `7H` | OK, `pén` 0, tour de B normal |
| K10 | R5 décochée, R6 cochée, `pén` 4 | B joue `7S` | `MUST_COUNTER_OR_DRAW` |
| K11 | R5 cochée, R6 décochée, `pén` 2 | B joue `XR` | `MUST_COUNTER_OR_DRAW` |
| K12 | `pén` 6, pioche 3 cartes, talon d'une seule carte | B `DRAW` | B reçoit 3 cartes, le reste est annulé, `pén` 0 |

## C. Combinaisons (R8)

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| C1 | talon `8H` | A joue `[8S, 8D]` | OK, carte visible `8D` |
| C2 | talon `5H` | A joue `[8S, 8H]` | `ILLEGAL_PLAY` (la 1ʳᵉ carte doit être jouable) ; `[8H, 8S]` : OK, visible `8S` |
| C3 | talon `8H` | A joue `[8H, 9H]` | `INVALID_COMBO` |
| C4 | talon `5H` | A joue `[7H, XB]` | OK, `pén` 6, visible `XB`, `ouv` B |
| C5 | talon `5H`, R7 cochée | A joue `[XB, 7H]` | OK, `pén` 6, visible `7H`, `ouv` null |
| C6 | talon `5H`, R7 décochée | A joue `[XB, 7H]` | `ILLEGAL_PLAY` ; `[7H, XB]` : OK |
| C7 | `pén` 2 | B joue `[7S, XR]` | OK, `pén` 8 |
| C8 | talon `5H` | A joue `[JH, JS]`, couleur `C` | OK, `dem` = C |
| C9 | R8 décochée, talon `8H` | A joue `[8S, 8D]` | `INVALID_COMBO` |
| C10 | talon `7S` encaissé | A joue `[7H, 7D, XB]` | OK, `pén` 8 |
| C11 | A n'a pas `8D` | A joue `[8S, 8D]` | `CARD_NOT_IN_HAND` |
| C12 | — | A joue `[8S, 8S]` | `INVALID_COMBO` (doublon) |
| C13 | — | A joue `[2H, 5H]` | `INVALID_COMBO` |
| C14 | talon `5H` | A joue `[XR, XB]` | OK, `pén` 8, visible `XB`, `ouv` B |
| C15 | `pén` 2 | B joue `[XB, XR]` | OK, `pén` 10, `ouv` R |
| C16 | R6 décochée, talon `5H` | A joue `[7H, XR]` | `INVALID_COMBO` |
| C17 | R5 décochée, talon `5H` | A joue `[7H, XR]` | OK, `pén` 4 (le 7 ne compte pas), visible `XR`, `ouv` R |
| C18 | R5 décochée, talon `5S` | A joue `[7S, XR]` | `INVALID_COMBO` (7 noir, Joker rouge) |
| C19 | R6 décochée, talon `5H` | A joue `[XR, XB]` | OK, `pén` 0, visible `XB`, `ouv` B |
| C20 | R5 décochée, `pén` 4 (talon `XB`) | B joue `[XR, 7H]` | `MUST_COUNTER_OR_DRAW` (le 7 ordinaire ne contre pas) |

## R. Pioche, temps écoulé, épuisement

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| R1 | `pén` 0, A a une carte jouable | A `DRAW` | A reçoit 1 carte, tour de B (même si la carte piochée est jouable) |
| R2 | suite de R1 | A joue | `NOT_YOUR_TURN` |
| R3 | `pén` 0 | `applyTimeout` | A reçoit 1 carte, raison `TIMEOUT`, tour de B, `missedTurns[A]` = 1 |
| R4 | `pén` 4 | `applyTimeout` | A reçoit 4 cartes, tour de B |
| R5 | `missedTurns[A]` = 2 | `applyTimeout` | A pioche d'abord (`CARDS_DRAWN`, raison `TIMEOUT`), puis est déclaré forfait (`PLAYER_FORFEIT`, raison `TIMEOUTS`) |
| R6 | `missedTurns[A]` = 2 | A joue un coup valide | `missedTurns[A]` remis à 0 |
| R11 | `missedTurns[A]` = 2 | A `DRAW` (pioche volontaire) | `missedTurns[A]` remis à 0 |
| R7 | pioche vide, talon `[3H, 4H, 9S]` (visible `9S`) | A `DRAW` | `3H` et `4H` mélangés en pioche, `9S` reste visible, A reçoit 1 carte, événement `DECK_RESHUFFLED` |
| R8 | pioche vide, talon d'une seule carte | A `DRAW` | 0 carte reçue, tour de B |
| R9 | pioche et talon épuisés, un tour de table complet sans pose | — | Fin de partie (`BLOCKED`) : le joueur qui a le moins de cartes gagne |
| R10 | comme R9, égalité au plus petit nombre de cartes | — | Partie nulle (`DRAW`) |

## CH. Annonce « Check »

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| CH1 | A a 2 cartes | A joue 1 carte avec `declareCheck` | OK, A marqué « Check », aucune fenêtre de dénonciation |
| CH2 | A a 2 cartes | A joue 1 carte sans `declareCheck` | Fenêtre ouverte (`CHECK_WINDOW` cible A) |
| CH3 | suite de CH2, avant toute action de B | C `CALL_CHECK` A | A reçoit 2 cartes, `CHECK_CALLED`, fenêtre fermée, le tour reste à B |
| CH4 | suite de CH2 | B joue un coup valide, puis C `CALL_CHECK` | `NO_CHECK_TO_CALL` |
| CH5 | suite de CH2 | C puis B `CALL_CHECK` | Seul C compte ; B reçoit `NO_CHECK_TO_CALL` |
| CH6 | suite de CH2 | A `CALL_CHECK` A | `NO_CHECK_TO_CALL` (seul un adversaire peut dénoncer) |
| CH7 | suite de CH2 | Temps de B écoulé (action automatique) | Fenêtre fermée |
| CH8 | 2 joueurs, A a 2 cartes | A joue `AH` sans annoncer | Fenêtre ouverte jusqu'à la prochaine action de A (qui rejoue) ; B peut dénoncer |
| CH9 | A a 3 cartes de même valeur | A les pose ensemble | Victoire, aucune annonce requise |
| CH10 | A marqué « Check » | A pioche (sa main passe à 2) | Marque « Check » retirée |
| CH11 | `declareCheck` envoyé alors que la main ne passe pas à 1 carte | A joue | OK, `declareCheck` ignoré |
| CH12 | suite de CH2, 4 joueurs | D abandonne | Fenêtre toujours ouverte ; C peut dénoncer A |
| CH13 | suite de CH2 | A abandonne | Fenêtre fermée |

## W. Victoire

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| W1 | A a 1 carte ordinaire jouable | A la joue | `GAME_OVER` : `WIN`, A, raison `EMPTY_HAND` |
| W2 | 3 joueurs, dernière carte de A `7H` | A la joue | Victoire immédiate de A ; B ne pioche pas |
| W3 | 2 joueurs, dernière carte de A `7H` | A la joue | Victoire immédiate de A ; B ne pioche pas et ne peut pas contrer |
| W4 | 2 joueurs, dernière carte de A `XR` | A la joue | Victoire immédiate de A |
| W5 | 2 joueurs, A n'a plus que `7H` et `XB` | A pose `[7H, XB]` | Victoire immédiate de A |
| W6 | 2 joueurs, A n'a que `AH` | A joue `AH` | `ACE_FINISH_FORBIDDEN` ; A doit piocher |
| W7 | 2 joueurs, A a `AH` et `5H`, talon `9H` | A joue `AH`, puis `5H` | A rejoue après l'As, puis gagne |
| W8 | 3 joueurs, A n'a que `AH` | A joue `AH` | Victoire de A |
| W9 | A n'a que `JS` | A joue `JS` sans couleur | Victoire de A (pas de couleur exigée sur la dernière carte) |
| W10 | 2 joueurs, R4 décochée, A n'a que `AH` | A joue `AH` | Victoire de A |
| W11 | 2 joueurs, A n'a plus que `2H` (R1 cochée) | A le joue | Victoire immédiate de A |
| W12 | B et C abandonnent | — | Victoire de A, raison `LAST_PLAYER` |
| W13 | 3 joueurs, C abandonne, puis A n'a que `AH` | A joue `AH` | `ACE_FINISH_FORBIDDEN` (N = 2 au moment de la pose) |
| W14 | 2 joueurs, A n'a plus que `AH` et `AS` | A pose `[AH, AS]` | `ACE_FINISH_FORBIDDEN` (une combinaison d'As ne peut pas vider la main à 2 joueurs) |

## F. Déconnexions et forfaits

| # | Situation | Action | Résultat attendu |
| ----- | ----- | ----- | ----- |
| F1 | tour de A commencé à t0 | A se déconnecte à t0 + 10 s | `turnDeadline` = t0 + 60 s |
| F2 | suite de F1 | A toujours absent à t0 + 60 s | Action automatique, tour de B |
| F3 | A toujours déconnecté, son tour revient | — | Action automatique **immédiate** |
| F4 | A déconnecté depuis 3 tours | 3ᵉ action automatique | Forfait de A (raison `DISCONNECTED`) |
| F5 | A reconnecté pendant son tour | `setConnected(A, true)` | Le `turnDeadline` en cours est conservé |
| F6 | Forfait de A (5 cartes) | — | Ses cartes vont **sous la pioche** ; talon inchangé ; A retiré de la rotation |
| F7 | `pén` 4 visant B | B abandonne | `pén` annulée, tour de C sans pénalité |
| F8 | Tour de A | A abandonne | Tour de B |
| F9 | Tour de B, A connecté | A se déconnecte, puis B joue (tour de A) | Action automatique de A **immédiate**, sans délai de grâce |

## S. Vue joueur et propriétés globales

| # | Vérification | Résultat attendu |
| ----- | ----- | ----- |
| S1 | `getPlayerView(state, A)` | Contient la main de A uniquement ; pour B et C seulement `handCount` |
| S2 | `getPlayerView` (tout joueur) | Ne contient jamais la pioche, seulement `deckCount` |
| S3 | Propriété (1 000 états aléatoires) | Toute carte de `legal.playable` est acceptée seule par `applyPlay` ; toute autre carte est refusée |
| S4 | Propriété (1 000 parties simulées jusqu'au bout avec coups aléatoires légaux) | À chaque étape : 54 cartes uniques réparties entre mains, pioche et talon ; aucune exception non prévue ; chaque partie se termine |
| S5 | Propriété | `applyPlay` ne modifie jamais l'état reçu en entrée (fonction pure) |
