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
      route: '/revert/:id',
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
  async findRevisions(query, options) {
    if(query._id) {
      query._id = this.db.ObjectId.parse(query._id);
    }
    if(query.itemId) {
      query.itemId = this.db.ObjectId.parse(query.itemId);
    }
    const results = await this.db.find(this.collectionName, query, { limit: 100, sort: { timestamp: -1 }, ...options });
    if(!results.length) {
      throw new Error(`No matching revisions found`);
    }
    return results;
  }
  /**
  * Handles reverting the changes from a single revision
  * @param {String} revisionId _id of the revision to undo
  */
  async undoRevision(revisionId) {
    const [revision] = await this.findRevisions({ _id: revisionId });
    await this.undoChangesRecursive(revision.changes);
  }
  /**
  * Handles reverting to a specific revision
  * @param {String} revisionId _id of the revision to revert to
  */
  async resetToRevision(revisionId) {
    const [targetRevision] = await this.findRevisions({ _id: revisionId });
    const revisions = await this.findRevisions({ timestamp: { $gt: targetRevision.timestamp } }, { timestamp: 1 });
    await this.undoChangesRecursive(revisions.reduce((m,r) => [...m, ...r.changes], []));
  }
  /**
  * Recursively reverts a list of changes
  * @param {Array} changes The changes to revert
  */
  async undoChangesRecursive(changes) {
    await this.undoChange(changes.shift());
    if(changes.length) await this.undoChangesRecursive(changes);
  }
  /**
  * Reverts a single change
  * @param {Object} change The change data to revert
  */
  async undoChange({ target, diff }) {
    const wasInsert = Array.isArray(diff) && diff.length === 1;
    const wasDelete = Array.isArray(diff) && diff.length === 3;
    const query = { _id: target._id };

    if(wasInsert) return this.content.delete(query);

    const [currentData] = await this.content.find({ _id: target._id });
    // we have to parse here to convert any ObjectId instances to string (otherwise validation plays up)
    const revertedData = JSON.parse(JSON.stringify(jsondiffpatch.unpatch(currentData, diff)));

    if(wasDelete) return this.content.insert(query, revertedData, { schemaName: target._type });
    // update/replace
    if(!currentData) {
      return this.log('warn', `Couldn't revert ${target._type} '${target._id}', no matching document found`);
    }
    delete revertedData._id;
    return this.content.update(query, revertedData, { schemaName: target._type });
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
      const [[course], revisions] = await Promise.all([
        this.content.find({ _id }),
        this.findRevisions({ itemId: _id })
      ]);
      res.json({ course, revisions });
    } catch(e) {
      next(e);
    }
  }
  /**
  * Request handler for revert route
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  */
  async revertHandler(req, res, next) {
    const _id = req.params.id;
    const isRecursive = req.query.recursive === 'true';
    try {
      const data = await (isRecursive ? this.resetToRevision(_id) : this.undoRevision(_id));
      res.json(data);
    } catch(e) {
      next(new Error(`Failed to revert to revision ${_id}`));
    }
  }
}

module.exports = VCSCourseModule;