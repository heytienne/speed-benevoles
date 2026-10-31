# Speed Festival - Appli bénévoles

Appli mobile installable depuis le navigateur (PWA), sans store, reliée à un Google Sheet.

```
Téléphone (PWA, hébergée gratuitement)  <->  Apps Script (backend/Code.js)  <->  Google Sheet
```

## Essayer tout de suite

Tant que `API_URL` est vide dans `js/config.js`, l'appli tourne en **mode démo** avec des données fictives
(comptes `Lou Bernard` et `Camille Martin`, mot de passe `demo`).

## Mise en production

### 1. Google Sheet et backend

1. Créez un Google Sheet, puis ouvrez **Extensions > Apps Script**.
2. Collez le contenu de `backend/Code.js` dans `Code.gs` et enregistrez.
3. Rechargez le Sheet : un menu **Speed** apparaît. Lancez **Initialiser les feuilles** et autorisez le script.
4. Dans Apps Script : **Déployer > Nouveau déploiement > Application Web**.
   - Exécuter en tant que : **Moi**
   - Accès : **Tout le monde**
5. Copiez l'URL finissant par `/exec`.

Après toute modification de `Code.js` : **Gérer les déploiements > Modifier > Nouvelle version**, sinon l'ancienne version reste active.

### 2. Appli

1. Mettez l'URL dans `API_URL` de `js/config.js`, ainsi que les dates et le lieu de l'édition.
2. Hébergez le dossier sur un site HTTPS gratuit (GitHub Pages, Netlify ou Cloudflare Pages).
3. Sur le téléphone, ouvrez le lien puis **Ajouter à l'écran d'accueil**.

### 3. Logo officiel

Le logo affiché est une recréation en texte. Déposez le fichier officiel, par exemple `assets/logo.png`
sur fond transparent, puis indiquez `LOGO_URL: 'assets/logo.png'` dans `js/config.js`.

## Remplir le Google Sheet

| Feuille | Colonnes | Remarques |
|---|---|---|
| **Utilisateurs** | `id`, `nom`, `telephone`, `email`, `genre`, `mot_de_passe`, `poles` | `genre` : `manager` ou `bénévole`. `poles` : managers seulement, séparés par des virgules. |
| **Shifts** | `id`, `pole`, `intitule`, `date`, `debut`, `fin`, `lieu`, `nb_requis` | Date `28/08/2026`, heures `21:00`. Une fin avant le début signifie le lendemain. |
| **Affectations** | `shift_id`, `benevole_id` | Une ligne par bénévole et par shift. |
| **ModelesSMS** | `id`, `titre`, `texte` | Variables : `{prenom}`, `{shift}`, `{heure}`, `{lieu}`. |
| **Commentaires** | | Remplie par l'appli, visible des managers uniquement. |
| **Journal** | | Historique des changements faits par les managers. |

Le référent d'un bénévole est tout manager dont `poles` contient le pôle du shift : le nom doit être écrit de la même façon dans les deux feuilles.

**Mots de passe :** saisissez-les en clair, puis lancez **Speed > Chiffrer les mots de passe**. Sinon, chacun est chiffré à la première connexion de la personne. Pour réinitialiser un mot de passe, écrivez le nouveau en clair dans la cellule.

**Confidentialité :** limitez le partage du Sheet aux organisateurs. Il contient des données personnelles et les commentaires sur les bénévoles (à garder factuels, RGPD).

## Bon à savoir

- **SMS :** l'appli ouvre l'application SMS du manager avec le message prêt, et le manager appuie sur Envoyer. C'est gratuit, mais l'appli ne peut pas confirmer l'envoi.
- **Hors réseau :** le dernier planning chargé reste consultable. Les modifications demandent une connexion.
- **Chargement :** Apps Script met souvent 1 à 3 secondes à répondre.

## Publication automatique

À la fin de chaque intervention de Claude Code sur ce dossier, `tools/auto-publish.ps1` envoie les changements sur GitHub, et le site se met à jour en une à deux minutes. Le dépôt étant public, tout fichier du dossier est publié s'il n'est pas listé dans `.gitignore`. Pour désactiver : supprimez le bloc `Stop` de `.claude/settings.local.json`.

`backend/Code.js` reste à recoller dans Apps Script, avec une nouvelle version du déploiement.

## Tester en local (Windows)

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

Puis ouvrez http://localhost:8080/.
