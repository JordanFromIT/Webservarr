/**
 * WebServarr — login page (/login)
 *
 * A full-page document, not a soft-navigation page: the router never loads
 * it. Loaded by a classic script tag inside <main>, right after the card, so
 * the branding below is applied and the sign-in handlers are wired as soon as
 * the card is parsed; the rest (status, artwork, a branding fetch, the
 * signed-in check) waits for DOMContentLoaded. A file rather than inline
 * script: the CSP is script-src 'self'.
 */

// First, before anything that could throw: this script ran. The page's CSS
// shows a "Sign-in didn't load" hint after 2.5 s unless it did (login.html).
document.documentElement.setAttribute('data-login-js', '');

// The form starts hidden (login.html) so it never shows a sign-in method the
// admin turned off. It is shown once the methods are applied, and after 2.5 s
// in any case, whatever is still on its way (a slow /api/branding on a page
// that came without its branding): the form then keeps what the server-rendered
// page set, and a method that turns out to be off is refused by its route with
// a message in the form. Its handlers are wired below, before anything waits,
// so a form on screen always signs in through this script. Armed first, so
// nothing later in this file that throws can keep the form hidden.
var REVEAL_AFTER_MS = 2500;
function revealForm() {
    var f = document.getElementById('loginForm');
    if (f) f.classList.add('auth-ready');
}
setTimeout(revealForm, REVEAL_AFTER_MS);

// Plex PINs this page is completing: each one once (see finishPlexAuth).
var plexFinishing = {};

wireSignIn();

// The logo and the sign-in methods are known before the first paint: the
// branding is already in window.WEBSERVARR_THEME (theme-loader reads it from
// the page). Setting them here, as soon as the card is parsed, means the
// first frame is the finished card. Done later, the card painted with every
// method in it and no logo, then shrank and re-centred under the reader's
// eyes. The form stays invisible until .auth-ready either way (see the
// #loginForm rule in login.html); this only decides what is in it by then.
// The DOMContentLoaded handler below calls this again, for the rare page
// whose branding had to be fetched. Every step is safe to repeat.
function applyLoginBranding(theme) {
    // Show branding logo if configured. Its box (h-48) is there from the
    // moment it shows, and the w-full column around it keeps the image's
    // arriving width from moving anything.
    if (theme.logo_url) {
        var logoEl = document.getElementById('loginLogo');
        if (logoEl && logoEl.getAttribute('src') !== theme.logo_url) {
            logoEl.src = theme.logo_url;
        }
        if (logoEl) logoEl.classList.remove('hidden');
    }

    // --- Auth method visibility ---
    var authMethods = theme.auth_methods || {};
    // If auth_methods not loaded yet (no cache), default to showing simple auth
    var hasAnyAuthConfig = authMethods.simple !== undefined || authMethods.plex !== undefined || authMethods.authentik !== undefined;

    // Hide Plex button if not configured
    if (!authMethods.plex) {
        var plexBtn = document.getElementById('plexLoginBtn');
        if (plexBtn) plexBtn.classList.add('hidden');
    }

    // Show Authentik button if configured (its click is wired on DOMContentLoaded)
    if (authMethods.authentik) {
        var authentikBtn = document.getElementById('authentikLoginBtn');
        if (authentikBtn) authentikBtn.classList.remove('hidden');
    }

    // Hide SSO divider if no SSO buttons are visible
    if (!authMethods.plex && !authMethods.authentik) {
        var ssoDivider = document.getElementById('ssoDivider');
        if (ssoDivider) ssoDivider.classList.add('hidden');
    }

    // Hide simple auth form elements only if explicitly disabled (not when auth_methods missing)
    if (hasAnyAuthConfig && !authMethods.simple) {
        var formEl = document.getElementById('loginForm');
        var children = formEl.children;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            // Keep SSO buttons visible, hide form inputs and dividers
            if (child.id !== 'plexLoginBtn' && child.id !== 'authentikLoginBtn') {
                child.style.display = 'none';
            }
        }
    }
}
if (window.WEBSERVARR_THEME) applyLoginBranding(window.WEBSERVARR_THEME);

// --- Footer: system status badge ---
// A .ws-pill like the header's: every colour is in theme.css, keyed on
// data-state (ok / warn / err; "off" while loading or unavailable). The words
// stay theme text while all is well and take the status-text colour otherwise.
// The footer comes after this script, so it runs once the page is parsed.
function loadSystemStatus() {
    var badge = document.getElementById('loginSystemStatus');
    if (!badge) return;
    var text = badge.querySelector('[data-status-text]');
    function render(state, label) {
        badge.setAttribute('data-state', state);
        text.textContent = label;
    }
    function showUnavailable() {
        render('off', 'Can\u2019t check the server right now');
    }
    // Public aggregate endpoint (no auth) — the login page has no session yet.
    fetch('/api/integrations/status-summary').then(function(r) {
        return r.ok ? r.json() : null;
    }).then(function(data) {
        var overall = data && data.status;
        if (overall === 'issues') {
            render('err', 'Something\u2019s down');
        } else if (overall === 'degraded') {
            render('warn', 'Some things are slow');
        } else if (overall === 'online') {
            render('ok', 'Everything\u2019s running');
        } else {
            showUnavailable();
        }
    }).catch(showUnavailable);
}

// --- Helper: show login error message ---
function showLoginError(msg) {
    var errorDiv = document.getElementById('loginError');
    if (!errorDiv) {
        errorDiv = document.createElement('div');
        errorDiv.id = 'loginError';
        errorDiv.className = 'text-status-err-text text-sm text-center mt-2';
        var form = document.getElementById('loginForm');
        if (form) form.appendChild(errorDiv);
    }
    errorDiv.textContent = msg;
    setTimeout(function() { errorDiv.textContent = ''; }, 5000);
}

// --- Helper: complete Plex PIN auth (poll callback) ---
async function completePlexAuth(pinId) {
    try {
        var resp = await fetch('/auth/plex-callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin_id: pinId }),
        });
        // Another call is completing this PIN (the server claimed it for
        // that one); its answer is the one that counts.
        if (resp.status === 409) return;
        if (!resp.ok) {
            var err = await resp.json();
            if (err.detail && err.detail.indexOf('not yet authorized') !== -1) {
                // PIN not linked yet — retry
                setTimeout(function() { completePlexAuth(pinId); }, 2000);
                return;
            }
            throw new Error(err.detail || 'Authentication failed');
        }
        window.location.href = '/';
    } catch (e) {
        showLoginError('Plex authentication failed: ' + e.message);
    }
}

// Complete a PIN once. The popup's message, the popup-closed poll and a phone's
// return can all say the same sign-in is done; only the first goes on
// (completePlexAuth's own "not yet authorized" retries are not new starts).
function finishPlexAuth(pinId) {
    if (plexFinishing[pinId]) return;
    plexFinishing[pinId] = true;
    completePlexAuth(pinId);
}

document.addEventListener('DOMContentLoaded', async function() {
    loadSystemStatus();

    // --- Handle mobile return from Plex auth ---
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('plex_auth') === 'complete') {
        var pinId = sessionStorage.getItem('plex_pin_id');
        if (pinId) {
            sessionStorage.removeItem('plex_pin_id');
            finishPlexAuth(parseInt(pinId, 10));
            return; // Don't load the rest of the page
        }
    }

    // --- Rotating TMDB Backgrounds ---
    (async function() {
        try {
            var resp = await fetch('/api/integrations/backgrounds');
            if (!resp.ok) return;
            var urls = await resp.json();
            if (!Array.isArray(urls) || urls.length === 0) return;

            // Shuffle the array
            for (var i = urls.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = urls[i]; urls[i] = urls[j]; urls[j] = tmp;
            }

            var slideshow = document.getElementById('backdropSlideshow');
            var slideA = document.getElementById('backdropA');
            var slideB = document.getElementById('backdropB');
            var staticGrid = document.getElementById('staticPosterGrid');
            var currentIndex = 0;
            var activeSlide = 'A';

            // Preload an image and return a promise. Bounded: a request that
            // never settles (a stalled connection, a captive portal, a proxy
            // that buffers forever) would otherwise hold the rotation's
            // single flight for the rest of the page. 30s is longer than any
            // load that still deserves to be shown. After the timeout the
            // handlers are dropped, so a late onload does nothing; the
            // promise has already settled either way.
            function preload(url) {
                return new Promise(function(resolve, reject) {
                    var img = new Image();
                    var timer = setTimeout(function() {
                        img.onload = img.onerror = null;
                        reject();
                    }, 30000);
                    img.onload = function() { clearTimeout(timer); resolve(url); };
                    img.onerror = function() { clearTimeout(timer); reject(); };
                    img.src = url;
                });
            }

            // Ken Burns: each picture gets its own move (the CSS is on
            // .is-moving). Restarting it means taking the class off, letting
            // the style settle, and putting it back; the slide is still at
            // opacity 0 at that moment, so the snap back to scale 1 is never
            // seen. The direction is one of four corner classes and never
            // repeats the previous picture's.
            var DRIFTS = ['drift-nw', 'drift-ne', 'drift-sw', 'drift-se'];
            var lastDrift = Math.floor(Math.random() * DRIFTS.length);
            function restartDrift(slide) {
                lastDrift = (lastDrift + 1 + Math.floor(Math.random() * (DRIFTS.length - 1))) % DRIFTS.length;
                slide.classList.remove('is-moving', DRIFTS[0], DRIFTS[1], DRIFTS[2], DRIFTS[3]);
                void slide.offsetWidth; // commit the removal, so the animation starts over
                slide.classList.add('is-moving', DRIFTS[lastDrift]);
            }

            // Fade the next picture in on one slide and the current one out
            // on the other. The move restarts before the fade-in begins; the
            // outgoing slide is left alone, so it keeps its frame as it goes.
            function show(next, prev, url) {
                next.style.backgroundImage = 'url(' + url + ')';
                restartDrift(next);
                next.style.opacity = '1';
                prev.style.opacity = '0';
            }

            // Load first image
            var firstUrl = urls[0];
            await preload(firstUrl);

            // Hide static grid, show slideshow. The first move starts here,
            // once the slideshow is visible, not while it was hidden. With
            // one picture there is no rotation, so it drifts back and forth.
            if (staticGrid) staticGrid.style.display = 'none';
            slideshow.classList.remove('hidden');
            slideA.style.backgroundImage = 'url(' + firstUrl + ')';
            if (urls.length < 2) slideA.classList.add('is-solo'); else restartDrift(slideA);
            slideA.style.opacity = '1';
            currentIndex = 1;

            // Rotate every 10 seconds, one preload at a time. A tick that
            // fires while a preload is still pending does nothing: no index
            // advance, no second request. So a slow network only slows the
            // rotation and can never starve it, and a preload that resolves
            // is the newest by construction, so it is always shown. A failed
            // one releases the flight and is left behind. A candidate that is
            // the picture already on screen is skipped: crossfading a picture
            // onto itself would only reset its move in full view.
            var shownUrl = firstUrl;
            var loading = false;
            setInterval(async function() {
                if (urls.length < 2 || loading) return;
                var nextUrl = urls[currentIndex % urls.length];
                currentIndex++;
                if (nextUrl === shownUrl) return;

                loading = true;
                try {
                    await preload(nextUrl);
                } catch(e) {
                    return;
                } finally {
                    loading = false;
                }

                shownUrl = nextUrl;
                if (activeSlide === 'A') {
                    show(slideB, slideA, nextUrl);
                    activeSlide = 'B';
                } else {
                    show(slideA, slideB, nextUrl);
                    activeSlide = 'A';
                }
            }, 10000);

        } catch(e) {
            // Fetch failed — static grid stays visible
        }
    })();

    // Wait for branding data if not cached (theme-loader fetches async)
    if (!window.WEBSERVARR_THEME) {
        try {
            var brandResp = await fetch('/api/branding');
            var brandData = await brandResp.json();
            window.WEBSERVARR_THEME = brandData;
        } catch (e) { /* use empty defaults */ }
    }
    var theme = window.WEBSERVARR_THEME || {};
    // The site name (or, with none set, its absence) is rendered by the server.
    // The logo and the sign-in methods were set under the card before the
    // first paint; this repeats it for a page whose branding was fetched above.
    applyLoginBranding(theme);

    // Auth-method visibility is resolved — reveal the form (it starts hidden
    // via CSS to prevent the simple-auth fields flashing before Plex/SSO).
    revealForm();

    // If already authenticated, redirect to dashboard
    try {
        var authResp = await fetch('/auth/check-session');
        var authData = await authResp.json();
        if (authData.authenticated) {
            window.location.href = '/';
            return;
        }
    } catch (e) { /* Not authenticated, show login form */ }
});

// The form's and the sign-in buttons' handlers, wired when this script runs
// (the card is parsed by then), before any await: whenever the form is on
// screen, Enter and every button go through here, never a plain form post.
function wireSignIn() {
    // The Authentik button signs in through the OIDC login. It is hidden
    // unless Authentik is on (applyLoginBranding).
    var authentikLoginBtn = document.getElementById('authentikLoginBtn');
    if (authentikLoginBtn) {
        authentikLoginBtn.addEventListener('click', function() {
            window.location.href = '/auth/login';
        });
    }

    // Handle login form submission
    var loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        var username = document.getElementById('username').value;
        var password = document.getElementById('password').value;

        try {
            var response = await fetch('/auth/simple-login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username: username, password: password })
            });

            var data = await response.json();

            if (response.ok && data.success) {
                // Login successful, redirect to dashboard
                window.location.href = data.redirect || '/';
            } else {
                showLoginError(data.detail || 'Login failed. Please check your credentials.');
            }
        } catch (error) {
            showLoginError('Login error: ' + error.message);
        }
    });

    // --- Plex login via direct PIN-based OAuth ---
    var plexLoginBtn = document.getElementById('plexLoginBtn');
    if (plexLoginBtn) plexLoginBtn.addEventListener('click', async function() {
        var btn = this;
        var originalChildren = [];
        while (btn.firstChild) {
            originalChildren.push(btn.removeChild(btn.firstChild));
        }
        btn.disabled = true;
        btn.textContent = 'Connecting to Plex...';

        try {
            var resp = await fetch('/auth/plex-start', { method: 'POST' });
            if (!resp.ok) {
                var err = await resp.json();
                throw new Error(err.detail || 'Failed to start Plex auth');
            }
            var data = await resp.json();

            // Desktop: popup, Mobile: redirect
            var isMobile = /Mobi|Android/i.test(navigator.userAgent) || window.innerWidth < 768;

            if (isMobile) {
                sessionStorage.setItem('plex_pin_id', String(data.pin_id));
                window.location.href = data.auth_url;
            } else {
                var popup = window.open(data.auth_url, 'PlexAuth', 'width=800,height=600');
                window.addEventListener('message', function handler(e) {
                    // Only the popup this page opened, back on this origin
                    // (plex-callback.js posts to it). Another window holding
                    // a reference to this tab must not cut the sign-in short.
                    if (e.origin !== window.location.origin || !popup || e.source !== popup) return;
                    if (e.data && e.data.type === 'plex-auth-complete') {
                        window.removeEventListener('message', handler);
                        // The popup is closed next; the poll must not take
                        // that for a second completion.
                        clearInterval(pollInterval);
                        if (popup && !popup.closed) popup.close();
                        finishPlexAuth(data.pin_id);
                    }
                });
                // Fallback: poll in case popup closes without postMessage
                var pollInterval = setInterval(function() {
                    if (popup && popup.closed) {
                        clearInterval(pollInterval);
                        finishPlexAuth(data.pin_id);
                    }
                }, 1000);
            }
        } catch (e) {
            btn.disabled = false;
            // Restore original button children
            btn.textContent = '';
            for (var i = 0; i < originalChildren.length; i++) {
                btn.appendChild(originalChildren[i]);
            }
            showLoginError(e.message);
        }
    });
}
