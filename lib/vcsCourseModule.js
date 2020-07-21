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

    await this.initRouter();

    const actions = ['insert', 'update','replace','delete'];
    actions.forEach(a => this.content.on(a, (...args) => this.onAction(a, ...args)));

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
  async onAction(action, p1, p2) {
    const oldData = action !== 'insert' ? p1 : undefined;
    const newData = action === 'insert' ? p1 : p2;
    if(action === 'delete' && oldData._type === 'course') {
      return this.db.getCollection('revisions').deleteOne({ itemId: oldData._id });
    }
    const diff = jsondiffpatch.diff(oldData, newData);
    if(!diff) return;

    this.ignoreProperties.forEach(p => diff.hasOwnProperty(p) && delete diff[p]);
    if(!Object.keys(diff).length) return;

    const [contentItem] = action === 'delete' ? [oldData] : await this.content.find({ _id: oldData && oldData._id || newData && newData._id });
    const courseId = contentItem._type === 'course' ? contentItem._id : contentItem._courseId;
    const collection = this.content.collectionName;
    const target = { _id: contentItem._id, type: contentItem._type, collection };
    // note we access the MongoDB API directly to avoid an infinite event loop
    return this.db.getCollection('revisions').updateOne({ itemId: courseId }, {
      $set: { itemId: courseId, itemCollection: collection },
      $push: { revisions: { $each: [{ target, diff, timestamp: new Date().toISOString() }], $position: 0 } }
    }, { upsert: true });
  }
  async revertChange(itemId, revisionIndex, recursive) {
    const [itemData] = await this.db.find('revisions', { itemId: this.db.ObjectId.parse(itemId) });
    const revision = itemData.revisions[revisionIndex];
    if(!revision) {
      throw new Error(`Couldn't find revision index '${revisionIndex}' on ${itemId}`);
    }
    const items = {};
    const revs = recursive ? itemData.revisions.slice(0, (revisionIndex+1)) : [revision];

    for (let i = 0, r = revs[i]; i < revs.length; r = revs[++i]) {
      const data = items[r.target._id] || (await this.content.find({ _id: r.target._id }))[0];
      items[r.target._id] = jsondiffpatch.unpatch(data, r.diff);
    }
    await Promise.all(Object.entries(items).map(([_id, data]) => {
      try {
        if(data === undefined) {
          return this.content.delete({ _id });
        }
        const parsed = JSON.parse(JSON.stringify(data)); // to convert any ObjectId instances to string
        return this.content.replace({ _id }, parsed, { schemaName: data._type }, { upsert: true });
      } catch(e) {
        console.log('ERROR!!!', e);
      }
    }));
  }
  async getRevisionsHandler(req, res, next) {
    try {
      const courseId = this.db.ObjectId.parse(req.params._id);
      const [[course],[revisionsData]] = await Promise.all([
        this.content.find({ _id: courseId }),
        this.db.find('revisions', { itemId: courseId })
      ]);
      res.json({ course, ...revisionsData });
    } catch(e) {
      next(new Error(`Failed to find revisions for ${req.params._id}`));
    }
  }
  async revertHandler(req, res, next) {
    try {
      const data = await this.revertChange(req.body._id, Number(req.body.revision), req.body.recursive === 'true');
      res.json(data);
    } catch(e) {
      console.log(e);
      next(new Error(`Failed to revert to revision ${req.params.index}`));
    }
  }
}

module.exports = VCSCourseModule;