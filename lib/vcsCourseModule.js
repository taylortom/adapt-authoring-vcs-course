const { AbstractModule } = require('adapt-authoring-core');

class VCSCourseModule extends AbstractModule {
  /** @override */
  constructor(app, pkg) {
    super(app, pkg);
    this.ignoreProperties = ['createdAt', 'updatedAt'];
    this.init();
  }
  async init() {
    const [content, vcs] = await this.app.waitForModule('content', 'vcs');
    vcs.on(`change:content`, this.onCourseContentChange(content, vcs));
    this.setReady();
  }
  onCourseContentChange(content, vcs) {
    return async ({ diff, itemId }) => {
      const diffs = diff.filter(d => !this.ignoreProperties.includes(d.path[0]));
      if(!diffs.length) {
        return;
      }
      const [contentItem] = await content.find({ _id: itemId });
      const courseId = contentItem._type === 'course' ? contentItem._id : contentItem._courseId;
      vcs.saveRevision(courseId, diffs);
    }
  }
}

module.exports = VCSCourseModule;