const { AbstractModule } = require('adapt-authoring-core');
const jsondiffpatch = require('jsondiffpatch');
// const DeepDiff = require('deep-diff');

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
    this.setReady();
  }
  async onMongoDBAction(itemCollection, oldData, newData) {
    const diff = jsondiffpatch.diff(oldData, newData);
    if(!diff) {
      return;
    }
    this.ignoreProperties.forEach(p => diff.hasOwnProperty(p) && delete diff[p]);

    if(!Object.keys(diff).length) {
      return;
    }
    const itemId = oldData._id;
    const [contentItem] = await this.content.find({ _id: itemId });
    const courseId = contentItem._type === 'course' ? contentItem._id : contentItem._courseId;
    // note we access the MongoDB API directly to avoid an infinite event loop
    return this.db.getCollection('revisions').updateOne({ itemId: courseId }, {
      $set: {
        itemId: courseId,
        itemCollection: this.content.collectionName
      },
      $push: {
        revisions: {
          targetId: contentItem._id,
          targetCollection: this.content.collectionName,
          diff: diff,
          timestamp: new Date().toISOString()
        }
      }
    }, { upsert: true });
  }
  async revertChange(itemId, revisionIndex) {
    const [itemData] = await this.db.find('revisions', { itemId: this.db.ObjectId.parse(itemId) });
    const iTooBig = revisionIndex > itemData.revisions.length-1;
    const iTooSmall = revisionIndex < 0 && revisionIndex*-1 > itemData.revisions.length;
    if(iTooBig || iTooSmall) {
      throw new Error(`Couldn't find revision index '${revisionIndex}' on ${itemId}`);
    }
    const items = {};
    const revisions = itemData.revisions.slice(revisionIndex);

    for (let i = revisions.length-1, r = revisions[i]; i > -1; r = revisions[--i]) {
      const data = items[r.targetId] || (await this.content.find({ _id: r.targetId }))[0];
      items[r.targetId] = jsondiffpatch.patch(data, jsondiffpatch.reverse(r.diff));
    }
    return Promise.all(Object.entries(items).map((_id, data) => this.content.replace({ _id }, data)));
  }
}

module.exports = VCSCourseModule;