// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
define(function(require){
  var Origin = require('core/origin');
  var OriginView = require('core/views/originView');

  var RevisionsView = OriginView.extend({
    className: 'revisions',
    events: {
      'click button[data-sort]': 'onSortClick'
    },

    initialize: function() {
      OriginView.prototype.initialize.apply(this, arguments);
      Origin.trigger('location:title:update', { title: Origin.l10n.t('app.usermanagementtitle') });
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
