# Accès à distance — mise en place (Cloudflare + Microsoft 365)

Procédure à suivre une seule fois pour piloter l'agent depuis l'iPhone ou un
autre PC personnel. Les menus Cloudflare et Microsoft évoluent souvent : les
noms ci-dessous sont indicatifs, à vérifier écran par écran.

## Ce qu'on met en place

```
iPhone / PC ──https──▶ Cloudflare (connexion Microsoft 365 + MFA)
                            │  tunnel sortant, aucun port ouvert sur la box
                            ▼
              cloudflared (service Windows, sur la VM)
                            │
                            ▼
              Agent : 127.0.0.1:47821 (appairage des appareils)
```

Deux verrous : la connexion Cloudflare (compte Microsoft 365 avec double
authentification) puis l'appairage de chaque appareil dans l'agent.

## 1. Microsoft Entra ID (administration Microsoft 365)

1. Portail Entra ID → **Inscriptions d'applications** → **Nouvelle inscription**.
   - Nom : `Cloudflare Access — Agent`
   - Comptes : *cette organisation uniquement*
   - URI de redirection (Web) : `https://<équipe>.cloudflareaccess.com/cdn-cgi/access/callback`
     (`<équipe>` = nom d'équipe Cloudflare Zero Trust, voir étape 2.1)
2. Noter l'**ID d'application (client)** et l'**ID de l'annuaire (locataire)**.
3. **Certificats et secrets** → nouveau secret client → noter sa **valeur**
   (affichée une seule fois).
4. **Autorisations d'API** : `openid`, `email`, `profile` (Microsoft Graph,
   délégué) → accorder le consentement administrateur.

## 2. Cloudflare Zero Trust

1. Tableau de bord Cloudflare → **Zero Trust**. Au premier accès, choisir un
   nom d'équipe (→ domaine `<équipe>.cloudflareaccess.com`) et l'offre
   **Free** (gratuite jusqu'à 50 utilisateurs).
2. **Paramètres → Authentification → Méthodes de connexion** → ajouter
   **Azure AD / Microsoft Entra ID** avec les trois valeurs de l'étape 1.
   Tester la connexion.
3. **Réseaux → Tunnels** → **Créer un tunnel** → type *Cloudflared* → nom
   `agent-vm`. Cloudflare affiche une commande d'installation Windows
   contenant un jeton : la garder pour l'étape 3.
4. Dans le tunnel → **Nom d'hôte public** :
   - Sous-domaine `agent`, domaine `elyone.com`
   - Service : `HTTP` → `localhost:47821`
5. **Access → Applications** → **Ajouter** → *Auto-hébergée* :
   - Domaine : `agent.elyone.com`
   - Durée de session : 12 h
   - Méthode de connexion : uniquement Microsoft Entra ID
   - Politique : *Autoriser* → *E-mails* → `johann@elyone.com`
6. Dans l'application créée → noter l'**AUD (Application Audience Tag)**.

## 3. Sur la VM Windows

1. Installer cloudflared : `winget install --id Cloudflare.cloudflared`
   (sur Windows ARM64, la version x64 tourne en émulation).
2. Installer le service avec le jeton de l'étape 2.3 (PowerShell administrateur) :
   `cloudflared.exe service install <jeton>`
   Le service démarre avec Windows, indépendamment de l'agent.
3. Dans l'agent → **Réglages → Accès à distance** :
   - Domaine d'équipe : `<équipe>.cloudflareaccess.com`
   - AUD de l'application : valeur de l'étape 2.6
   - Email autorisé : `johann@elyone.com` → **Enregistrer**
   - Cocher **Lancer l'agent à l'ouverture de la session Windows**
   - Activer l'accès à distance

## 4. Vérifications

1. Navigateur privé, non connecté → `https://agent.elyone.com` doit afficher
   la page de connexion Cloudflare, rien d'autre.
2. iPhone → Safari → `https://agent.elyone.com` → connexion Microsoft →
   un code d'appairage s'affiche → l'accepter sur le PC en vérifiant le code.
3. Safari → Partager → **Sur l'écran d'accueil**. Ouvrir l'icône → accepter
   les alertes de connexion.
4. Couper l'accès dans les réglages → l'iPhone doit perdre la connexion
   immédiatement.

## En cas de doute

- Couper l'interrupteur **Accès à distance** dans les réglages (effet
  immédiat), ou depuis un appareil appairé.
- Révoquer l'appareil suspect dans la liste des appareils appairés.
- Désactiver l'application dans Cloudflare Access : plus personne n'entre.
