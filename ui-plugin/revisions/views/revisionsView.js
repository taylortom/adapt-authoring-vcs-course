// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
define(function(require){
  var Backbone = require('backbone');
  var ApiCollection = require('core/collections/apiCollection');
  var Origin = require('core/origin');
  var OriginView = require('core/views/originView');

  var RevisionsView = OriginView.extend({
    className: 'revisions',
    settings: { autoRender: false },
    
    initialize: function(options) {
      OriginView.prototype.initialize.call(this, options);
      console.log(options);
     
      this.model = new Backbone.Model({ 
        revisions: new ApiCollection(undefined, { url: 'api/revisions' }) 
      });
      this.model.on('change', this.render, this);

      this.fetch();
    },
    
    fetch: function() {
      this.model.get('revisions').fetch();
    }
  }, {
    template: 'revisions'
  });

  return RevisionsView;
});
