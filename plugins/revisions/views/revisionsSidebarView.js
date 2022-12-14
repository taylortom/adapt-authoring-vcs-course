define([
  'core/origin',
  'modules/sidebar/views/sidebarItemView',
], function(Origin, SidebarItemView, FilterView) {
  var RevisionsSidebarView = SidebarItemView.extend({
    events: {},
  }, {
    template: 'revisionsSidebar'
  });

  return RevisionsSidebarView;
});
