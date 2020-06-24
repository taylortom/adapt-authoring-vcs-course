const { AbstractModule } = require('adapt-authoring-core');
const jsondiffpatch = require('jsondiffpatch');

class VCSCourseModule extends AbstractModule {
  /** @override */
  constructor(app, pkg) {
    super(app, pkg);
    this.init();
  }
  async init() {
    const [content, mongodb] = await this.app.waitForModule('content','mongodb');
    this.content = content;
    this.db = mongodb;
    this.ignoreProperties = ['createdAt', 'updatedAt'];

    ['insert', 'update','replace','delete'].forEach(a => {
      this.db.on(a, this.onMongoDBAction.bind(this));
    });
    await this.initRouter();
    this.setReady();
  }
  async initRouter() {
    const [auth, server] = await this.app.waitForModule('auth', 'server');
    this.router = server.api.createChildRouter('vcs/course');
    this.router.addRoute({
      route: '/revisions/:_id',
      handlers: { get: this.getRevisionsHandler.bind(this) }
    }, {
      route: '/revert',
      handlers: { post: this.revertHandler.bind(this) }
    });
    auth.permissions.secureRoute(`${this.router.path}/revisions`, 'get', ['read:revisions']);
    auth.permissions.secureRoute(`${this.router.path}/revert`, 'post', ['write:revisions']);
  }
  async onMongoDBAction(itemCollection, oldData, newData) {
    if(itemCollection !== 'content') return;

    const diff = jsondiffpatch.diff(oldData, newData);
    if(!diff) return;

    this.ignoreProperties.forEach(p => diff.hasOwnProperty(p) && delete diff[p]);
    if(!Object.keys(diff).length) return;

    const itemId = oldData._id;
    const [contentItem] = await this.content.find({ _id: itemId });
    const courseId = contentItem._type === 'course' ? contentItem._id : contentItem._courseId;
    const collection = this.content.collectionName;
    const target = { _id: contentItem._id, type: contentItem._type, collection };
    // note we access the MongoDB API directly to avoid an infinite event loop
    return this.db.getCollection('revisions').updateOne({ itemId: courseId }, {
      $set: { itemId: courseId, itemCollection: collection },
      $push: { revisions: { $each: [{ target, diff, timestamp: new Date().toISOString() }], $position: 0 } }
    }, { upsert: true });
  }
  async revertChange(itemId, revisionIndex) {
    const [itemData] = await this.db.find('revisions', { itemId: this.db.ObjectId.parse(itemId) });
    if(revisionIndex === undefined || revisionIndex < 0 || revisionIndex > itemData.revisions.length-1) {
      throw new Error(`Couldn't find revision index '${revisionIndex}' on ${itemId}`);
    }
    const items = {};
    const revs = itemData.revisions.slice(0, revisionIndex+1);

    for (let i = 0, r = revs[i]; i < revs.length; r = revs[++i]) {
      const data = items[r.target._id] || (await this.content.find({ _id: r.target._id }))[0];
      items[r.target._id] = jsondiffpatch.patch(data, jsondiffpatch.reverse(r.diff));
    }
    await Promise.all(Object.entries(items).map(([_id, data]) => {
      const parsed = JSON.parse(JSON.stringify(data)); // to convert any ObjectId instances to string
      return this.content.replace({ _id }, parsed, { schemaName: data._type });
    }));
    return this.db.getCollection('revisions').updateOne({ itemId: this.db.ObjectId.parse(itemId) }, {
      $set: { revisions: itemData.revisions.slice(revisionIndex+1) }
    });
  }
  async getRevisionsHandler(req, res, next) {
    const courseId = this.db.ObjectId.parse(req.params._id);
    try {
      const [[course],[revisionsData]] = await Promise.all([
        this.content.find({ _id: courseId }),
        this.db.find('revisions', { itemId: courseId })
      ]);
      res.json({ course, ...revisionsData });
    } catch(e) {
      next(new Error(`Failed to find revisions for ${courseId}`));
    }
  }
  async revertHandler(req, res, next) {
    try {
      const data = await this.revertChange(req.body._id, req.body.revision);
      res.json(data);
    } catch(e) {
      console.log(e);
      next(new Error(`Failed to revert to revision ${req.params.index}`));
    }
  }
}

module.exports = VCSCourseModule;