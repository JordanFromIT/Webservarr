# Authentik OIDC Setup Guide

## Why Authentik?

Plex doesn't provide a traditional identity provider -- it's a media server, not an auth platform. If you run multiple services for your users (Seerr, Organizr, wikis, forums, etc.), each one needs its own login mechanism. Authentik solves this by acting as a **translational authentication layer** between Plex and everything else.

When a user signs in with their Plex account through Authentik, Authentik creates a local identity for them. That identity can then be used to authenticate against any service you connect to Authentik -- not just WebServarr. This gives you:

- **Single sign-on (SSO)** across all your services using Plex as the identity source
- **Centralized user management** -- onboard/offboard users in one place instead of per-service
- **Audit logging** -- see who logged in, when, and to which service
- **Granular access control** -- restrict which Plex users can access which services

**If you just want users to sign in with Plex for WebServarr only**, use direct Plex OAuth instead. It requires no additional infrastructure and is configured entirely in Settings > Integrations > Plex.

## Prerequisites

- WebServarr running and accessible (complete the [setup guide](setup.md) first)
- A domain with HTTPS (required for OAuth redirects)
- A Plex account with admin access to your Plex server (you will authenticate through Authentik's Plex source setup)
- A running Authentik instance with admin access -- follow the [official Authentik Docker Compose installation guide](https://docs.goauthentik.io/install-config/install/docker-compose/) if you don't have one yet

## Configure Authentik

Log in to the Authentik admin interface to complete the following steps.

### Step 1: Create a Plex Source

This allows users to authenticate with their Plex account through Authentik.

1. Navigate to **Directory > Federation & Social login**
2. Click **Create** in the top right
3. Select **Plex** from the source type list
4. Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `Plex` (or any descriptive name) |
| Slug | `plex` (auto-generated from name) |
| Client ID | Leave the auto-generated value |
| Allowed servers | Click the blue **Load servers** button. You will be prompted to authenticate with your Plex admin account. Once authenticated, your servers will populate -- check the box next to your Plex server |
| Allow friends | Uncheck this unless you want all Plex friends to be able to log in |

5. Leave **Authentication flow** and **Enrollment flow** at their defaults
6. Click **Create**

### Step 2: Create the "Plex Direct Login" Flow

This custom flow shows only the Plex login button (no username/password fields), creating a seamless login experience.

#### 2a. Create the flow

1. Navigate to **Flows and Stages > Flows**
2. Click **Create**
3. Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `Plex Direct Login` |
| Title | `Plex Direct Login` |
| Slug | `plex-direct-login` |
| Designation | Authentication |
| Authentication | No requirement |
| Layout | Stacked |

4. Click **Create**

#### 2b. Create an identification stage

1. Navigate to **Flows and Stages > Stages**
2. Click **Create**
3. Select **Identification Stage**
4. Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `plex-only-identification` |
| User fields | Leave **empty** (do not select any) |
| Sources | Select the Plex source you created in Step 1 |

5. Leave all other fields at their defaults
6. Click **Finish**

#### 2c. Bind the stage to the flow

1. Navigate back to **Flows and Stages > Flows**
2. Click on **Plex Direct Login** to open it
3. Go to the **Stage Bindings** tab
4. Click **Bind existing stage**
5. Fill in the fields:

| Field | Value |
|-------|-------|
| Stage | `plex-only-identification` |
| Order | `10` |

6. Click **Create**

### Step 3: Create the "Plex Token" Property Mapping

This custom scope mapping passes the user's Plex token through to WebServarr, enabling Plex avatar display and Seerr SSO.

1. Navigate to **Customization > Property Mappings**
2. Click **Create**
3. Select **Scope Mapping**
4. Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `Plex Token Claim` |
| Scope name | `plex` |
| Expression | See below |

5. Paste this expression (note: it may appear word-wrapped in the editor, which is normal):

```python
from authentik.sources.plex.models import UserPlexSourceConnection

connection = UserPlexSourceConnection.objects.filter(user=request.user).first()
return {"plex_token": connection.plex_token if connection else ""}
```

6. Click **Finish**

### Step 4: Create the OAuth2/OIDC Provider

1. Navigate to **Applications > Providers**
2. Click **Create**
3. Select **OAuth2/OpenID Provider**
4. Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `WebServarr` (or any name) |
| Authorization flow | **default-provider-authorization-implicit-consent** |
| Authentication flow | **Plex Direct Login** (the flow from Step 2) |
| Client type | Confidential |
| Redirect URIs/Origins (RegEx) | Your WebServarr callback URL, e.g. `https://hmserver.tv/auth/callback`. This must exactly match your domain -- replace `hmserver.tv` with your actual domain. No trailing slash. |
| Redirect URIs matching mode | Strict |
| Signing key | **authentik Self-signed Certificate** |

5. Scroll down to **Advanced protocol settings**
6. In the **Scopes** field, add **Plex Token Claim** (the mapping from Step 3) alongside the default OpenID, Email, and Profile scopes
7. Click **Create**
8. After creation, open the provider detail page and note the **Client ID** and **Client Secret** -- you will need these for WebServarr

### Step 5: Create the Application

1. Navigate to **Applications > Applications**
2. Click **Create**
3. Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `WebServarr` |
| Slug | `webservarr` (note this -- you will need it) |
| Provider | Select the OAuth2 provider from Step 4 |
| Launch URL | `https://your-domain.com` (your WebServarr URL) |

4. Click **Create**

### Step 6: Configure WebServarr

1. Log in to WebServarr as admin
2. Go to **Settings > System > Authentication**
3. Enable the **Authentik OIDC** toggle
4. Fill in the fields:

| Field | Value |
|-------|-------|
| Authentik URL | Your Authentik base URL (e.g., `https://auth.example.com`) |
| Client ID | From the OAuth2 provider detail page (Step 4) |
| Client Secret | From the OAuth2 provider detail page (Step 4) |
| App Slug | The application slug from Step 5 (e.g., `webservarr`) |

5. Click **Save**

The **"Sign in with Plex (via Authentik)"** button will now appear on the login page.

### Step 7: Set the Admin Email

WebServarr determines admin status by comparing the logged-in user's email against the Plex server owner's email. If your Plex account email differs from what Authentik reports, set it explicitly:

1. Go to **Settings > System > Admin Account**
2. Set **Admin Email** to the email address associated with your Plex account
3. Click **Save**

---

## Verification

After completing the setup:

1. Open the WebServarr login page
2. Verify the **"Sign in with Plex (via Authentik)"** button is visible
3. Click the button -- you should be redirected to Authentik
4. Authentik shows a Plex login button (no username/password fields)
5. Click the Plex button -- a Plex popup window opens for authentication
6. After authenticating with Plex, the popup closes and you are redirected back to the WebServarr dashboard
7. Verify your username and avatar appear in the sidebar
8. If you are the server owner, verify you have access to the Settings page (admin check)

---

## Troubleshooting

**"Sign in with Plex (via Authentik)" button not appearing**

All four settings (URL, Client ID, Client Secret, App Slug) must be saved in Settings > System > Authentication. Verify none are blank.

**Redirect URI mismatch error**

The redirect URI in the Authentik OAuth2 provider must exactly match `https://your-domain.com/auth/callback` -- same scheme, domain, and path. No trailing slash. If you are behind a reverse proxy, make sure the proxy passes the correct `X-Forwarded-Proto` header so WebServarr generates the right callback URL.

**Plex popup blocked on mobile**

Authentik opens a Plex popup window during login. Some mobile browsers block popups by default. For mobile users, direct Plex OAuth (no Authentik) is the recommended auth method -- configure it in Settings > Integrations > Plex.

**Logout does not return to the WebServarr login page**

This is a known upstream Authentik limitation with end-session redirects. Users will land on the Authentik logout confirmation page rather than being redirected back automatically.

**User is not recognized as admin after login**

WebServarr checks admin status by comparing the logged-in user's email against:
1. The `system.admin_email` setting (if configured)
2. The Plex server owner's email (fetched via the Plex API using the configured token)

If neither matches, the user will not have admin access. Set your email explicitly in Settings > System > Admin Account > Admin Email.

**Plex token not available after login (no avatar, no Seerr SSO)**

Verify that:
- The "Plex Token Claim" property mapping was created (Step 3)
- The mapping is assigned to the OAuth2 provider's scopes (Step 4)
- The user has a Plex source connection in Authentik (Directory > Users > select user > Connections tab)

**Authentik takes too long to start**

First launch can take 1-2 minutes while Authentik runs database migrations. Check your Authentik server logs for `Starting authentik server` to confirm it is ready.

---

## Reverse Proxy Configuration

If Authentik runs behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel), configure it to proxy both HTTP and WebSocket traffic to port 9000:

### nginx

```nginx
server {
    listen 443 ssl;
    server_name auth.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Caddy

```
auth.example.com {
    reverse_proxy localhost:9000
}
```

### Cloudflare Tunnel

Point the hostname `auth.example.com` to `http://localhost:9000` in your tunnel configuration.

---

## Removal

To disconnect Authentik from WebServarr:

1. In WebServarr, go to **Settings > System > Authentication** and disable the **Authentik OIDC** toggle
2. Users who were logged in via Authentik will need to log in again using another method (simple auth or direct Plex OAuth)

To remove the Authentik instance itself, refer to the [Authentik documentation](https://docs.goauthentik.io/).
