import AbstractApiModule from 'adapt-authoring-api';
import jsondiffpatch from 'jsondiffpatch';
/**
 * Module to add version control for the 'course' content type
 * @extends {AbstractModule}
 */
export default class VcsCourseModule extends AbstractApiModule {
  /** @override */
  async init() {
    await super.init();

    const [content, ui] = await this.app.waitForModule('content', 'ui');
    /**
     * Reference to the ContentModule instance for convenience
     * @type {ContentModule}
     */
    this.content = content;
    /**
     * Properties to be ignored when checking for updates
     * @type {Array<String>}
     */
    this.ignoreProperties = ['createdAt', 'updatedAt'];

    ui.addUiPlugin(`${this.rootDir}/ui-plugin`);

    ['insert','update','delete'].forEach(action => { // note we just log any errors
      const hookName = `post${action[0].toUpperCase()}${action.slice(1)}Hook`;
      this.content[hookName].tap(async (...args) => {
        try {
          await this.onAction(action, ...args);
        } catch(e) {
          this.log('warn', 'STORE_REVISION', e);
        }
      });
    });
  }
  /** @override */
  async setValues() {
    /** @ignore */ this.root = 'revisions';
    /** @ignore */ this.schemaName = 'courserevision';
    /** @ignore */ this.collectionName = 'revisions';

    this.useDefaultRouteConfig();

    this.routes.push({
      route: '/revert/:_id',
      handlers: { post: this.revertHandler.bind(this) },
      permissions: { post: ['write:revisions'] }
    });
    // remove unsupported routes
    const r = this.routes.find(r => r.route === '/:_id');
    delete r.handlers.put;
    delete r.handlers.patch;
  }
  /**
   * Processes an incoming DB action
   * @param {String} action The action type _id of the target object
   * @param {Object} p1 Parameter 1 (data dependent on DB action)
   * @param {Object} p2 Parameter 2 (data dependent on DB action)
   */
  async onAction(action, p1, p2) {
    const isInsert = action === 'insert';
    const isUpdate = action === 'update';
    const isDelete = action === 'delete';
    let data;
    if(isDelete) {
      data = (Array.isArray(p1) ? p1 : [p1]).map(d => [d, undefined]);
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

      if(isUpdate) {
        delete newData.updatedAt;
      }
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
      return this.delete({ itemId: courseId });
    }
    if(changes.length) {
      return this.insert({
        itemId: courseId.toString(),
        itemCollection: this.content.collectionName,
        action,
        timestamp: new Date().toISOString(),
        changes
      });
    }
  }
  /**
   * Retrieves revisions from the database
   * @param {Object} query
   * @param {Object} options Options passed to the DB
   * @return {Object} Resolves with the query results
   */
  async findRevisions(query, options) {
    const mongodb = await this.app.waitForModule('mongodb');
    if(query._id) {
      query._id = mongodb.ObjectId.parse(query._id);
    }
    if(query.itemId) {
      query.itemId = mongodb.ObjectId.parse(query.itemId);
    }
    const results = await this.find(query, { limit: 100, sort: { timestamp: -1 }, ...options });
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
      return next(e);
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
      return next(new Error(`Failed to revert to revision ${_id}`));
    }
  }
}