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
  getDiff(leftSide, rightSide) {
    return jsondiffpatch.diff(leftSide, rightSide);
  }
  async onAction(action, p1, p2) {
    const isInsert = action === 'insert';
    const isDelete = action === 'delete';
    const data = isDelete ? p1.map(d => [d, undefined]) : isInsert ? [p1].map(d => [undefined, d]) : [p1, p2];
    const revisions = [];
    let courseId;
    let isCourseDelete = false;

    data.forEach(([oldData, newData]) => {
      const contentItem = isDelete ? oldData : newData;
      if(contentItem._type === 'course') {
        courseId = contentItem._id;
        if(isDelete) {
          isCourseDelete = true;
          return;
        }
      }
      if(!courseId) courseId = contentItem._courseId;
      // this.ignoreProperties.forEach(p => diff.hasOwnProperty(p) && delete diff[p]);
      // if(!Object.keys(diff).length) return;
      revisions.push({
        target: {
          _id: contentItem._id,
          type: contentItem._type,
          collection: this.content.collectionName
        },
        diff: jsondiffpatch.diff(oldData, newData),
        timestamp: new Date().toISOString()
      });
    });
    if(isCourseDelete) {
      return this.db.getCollection('revisions').deleteOne({ itemId: courseId });
    }
    if(revisions.length) { // note we access the MongoDB API directly to avoid an infinite event loop
      return this.db.getCollection('revisions').updateOne({ itemId: courseId }, {
        $set: { itemId: courseId, itemCollection: this.content.collectionName },
        $push: { revisions: { $each: revisions, $position: 0 } }
      }, { upsert: true });
    }
  }
  async revertChange(itemId, revisionIndex, recursive) {
    const [itemData] = await this.db.find('revisions', { itemId: this.db.ObjectId.parse(itemId) });
    const revision = itemData.revisions[revisionIndex];
    if(!revision) {
      throw new Error(`Couldn't find revision index '${revisionIndex}' on ${itemId}`);
    }
    const items = {};
    const revs = recursive ? itemData.revisions.slice(0, revisionIndex+1) : [revision];

    for (let i = 0, r = revs[i]; i < revs.length; r = revs[++i]) {
      const data = items[r.target._id] || (await this.content.find({ _id: r.target._id }))[0];
      items[r.target._id] = jsondiffpatch.unpatch(data, r.diff);
    }
    await Promise.all(Object.entries(items).map(([_id, data]) => {
      if(data === undefined) {
        return this.content.delete({ _id });
      }
      const parsed = JSON.parse(JSON.stringify(data)); // to convert any ObjectId instances to string
      return this.content.replace({ _id }, parsed, { schemaName: data._type }, { upsert: true });
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
      next(new Error(`Failed to revert to revision ${req.params.index}`));
    }
  }
}

module.exports = VCSCourseModule;