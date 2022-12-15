// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
define(function(require){
  var Origin = require('core/origin');
  var OriginView = require('core/views/originView');

  var RevisionsView = OriginView.extend({
    className: 'revisions',
    events: {
      'click button[data-sort]': 'onSortClick'
    },

    initialize: function(options) {
      OriginView.prototype.initialize.call(this, options);
      console.log(options);
      Origin.trigger('location:title:update', { title: Origin.l10n.t('app.revisionstitle') });
      Origin.trigger('sidebar:sidebarContainer:hide');
      this.render();
    },

    render: function() {
      OriginView.prototype.render.apply(this, arguments);
    }
  }, {
    template: 'revisions'
  });

  return RevisionsView;
});
