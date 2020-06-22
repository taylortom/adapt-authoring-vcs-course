const { AbstractModule } = require('adapt-authoring-core');

class VCSCourseModule extends AbstractModule {
  /** @override */
  constructor(app, pkg) {
    super(app, pkg);
    this.init();
  }
  async init() {
    const vcs = await this.app.waitForModule('vcs');
    vcs.on(`change:content`, this.onCourseContentChange.bind(this));
    this.setReady();
  }
  async onCourseContentChange({ action, diff, oldData, newData, itemCollection, itemId }) {
    /** @todo */
  }
}

module.exports = VCSCourseModule;