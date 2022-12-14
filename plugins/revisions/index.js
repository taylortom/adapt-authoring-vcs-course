define(function(require) {
  var Origin = require('core/origin');
  var RevisionsView = require('./views/revisionsView');
  var RevisionsSidebarView = require('./views/revisionsSidebarView');

  var scopes = ["write:revisions"];

  Origin.on('router:initialize', () => Origin.router.restrictRoute('revisions', scopes));
  
  Origin.on('origin:dataReady', () => {
    Origin.globalMenu.addItem({
      location: "global",
      text: Origin.l10n.t('app.revisions'),
      icon: "fa-undo",
      route: "revisions",
      scopes
    });
  });

  Origin.on('router:revisions', function(location, subLocation, action) {
    Origin.contentPane.setView(RevisionsView, { model, collection: userCollection });
    Origin.sidebar.addView(new RevisionsSidebarView({ model, collection: new ApiCollection() }).$el);
  });
});
