/**
 * Settings > General: site name, tagline, logo, backup.
 * Task 3.2 ships the first two fields; Task 4.3 completes the tab.
 */
(function () {
  'use strict';

  WSSettings.registerTab('general', {
    mount: function (panel, api) {
      var site = WSSettings.card('Your site', 'The name and words people see when they visit.');
      site.body.appendChild(api.text({
        key: 'branding.app_name', label: 'Site name',
        help: 'Shown in the sidebar, on the sign-in page and in browser tabs. Leave it empty to show only your logo.'
      }));
      site.body.appendChild(api.text({
        key: 'branding.tagline', label: 'Tagline',
        help: 'Shown under the site name on the sign-in page, and in link previews when someone shares your site.'
      }));
      panel.appendChild(site.root);
    }
  });
})();
