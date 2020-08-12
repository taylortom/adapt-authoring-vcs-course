const { AbstractModule } = require('adapt-authoring-core');
const jsondiffpatch = require('jsondiffpatch');
/**
* Module to add version control for the 'course' content type
*/
class VCSCourseModule extends AbstractModule {
  /** @override */
  constructor(app, pkg) {
    super(app, pkg);
    this.init();
  }
  /** @override */
  async init() {
    const [content, jsonschema, mongodb] = await this.app.waitForModule('content', 'jsonschema', 'mongodb');
    this.collectionName = 'revisions';
    this.content = content;
    this.db = mongodb;
    this.jsonschema = jsonschema;
    this.ignoreProperties = ['createdAt', 'updatedAt'];

    await this.initRouter();

    const actions = ['insert', 'update','replace','delete'];
    actions.forEach(a => this.content.on(a, (...args) => {
      this.onAction(a, ...args).catch(e => this.log('warn', `failed to store course revision, ${e}`));
    }));

    this.setReady();
  }
  /**
  * Initialises the router/routes
  */
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
  /**
  * Compares two JSON objects and returns the changes as diff data
  * @param {Object} leftSide Data to be used as the base (i.e. old)
  * @param {Object} rightSide Data to be used as changes (i.e. new)
  * @return {Array|Object} Delta data
  * @see https://github.com/benjamine/jsondiffpatch/blob/master/docs/deltas.md
  */
  getDiff(leftSide, rightSide) {
    return jsondiffpatch.diff(leftSide, rightSide);
  }
  /**
  * Processes an incoming DB action
  * @param {String} action The action type _id of the target object
  * @param {Object} p1 Parameter 1 (data dependent on DB action)
  * @param {Object} p2 Parameter 2 (data dependent on DB action)
  */
  async onAction(action, p1, p2) {
    const isInsert = action === 'insert';
    const isDelete = action === 'delete';
    let data;
    if(isDelete) {
      data = p1.map(d => [d, undefined]);
    } else if(isInsert) {
      data = (Array.isArray(p1) ? p1 : [p1]).map(d => [undefined, d]);
    } else {
      data = [[p1, p2]];
    }
    let courseId;
    let isCourseDelete = false;
    const changes = [];
    data.forEach(([oldData, newData]) => {
      if(isCourseDelete) {
        return;
      }
      const contentItem = isDelete ? oldData : newData;
      if(contentItem._type === 'course') {
        courseId = contentItem._id;
        if(isDelete) {
          isCourseDelete = true;
          return;
        }
      }
      if(!courseId) courseId = contentItem._courseId;

      const diff = jsondiffpatch.diff(oldData, newData);

      if(diff) {
        changes.push({
          diff,
        target: {
            _id: contentItem._id.toString(),
          type: contentItem._type,
          collection: this.content.collectionName
        }
      });
      }
    });
    if(isCourseDelete) {
      return this.db.delete({ itemId: courseId });
    }
    if(changes.length) {
      const validated = await this.jsonschema.validate('courserevision', {
        itemId: courseId.toString(),
        itemCollection: this.content.collectionName,
        action,
        timestamp: new Date().toISOString(),
        changes
      });
      return this.db.insert(this.collectionName, validated);
    }
  }
  /**
  * Request handler for revert route
  * @param {String} itemId _id of the target object
  * @param {Number} revisionIndex The index of the revision to revert
  * @param {Boolean} recursive Whether the function should recursively revert each commit (from newest to oldest)
  */
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
    return Promise.all(Object.entries(items).map(([_id, data]) => {
      if(data === undefined) {
        return this.content.delete({ _id });
      }
      const parsed = JSON.parse(JSON.stringify(data)); // to convert any ObjectId instances to string
      return this.content.replace({ _id }, parsed, { schemaName: data._type }, { upsert: true });
    }));
    */
  }
  async getRevisions(courseId) {
    const itemId = this.db.ObjectId.parse(courseId);
    return this.db.find(this.collectionName, { itemId }, { limit: 100, sort: { timestamp: -1 } });
  }
  /**
  * Request handler for retrieving routes
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  */
  async getRevisionsHandler(req, res, next) {
    const _id = req.params._id;
    try {
      const [[course], revisions] = await Promise.all([this.content.find({ _id }), this.getRevisions(_id)]);
      res.json({ course, revisions });
    } catch(e) {
      next(new Error(`Failed to find revisions for ${_id}`));
    }
  }
  /**
  * Request handler for revert route
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  */
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