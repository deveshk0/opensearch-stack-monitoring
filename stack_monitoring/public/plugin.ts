import { DEFAULT_APP_CATEGORIES } from "../../../src/core/public";
import type { CoreSetup, AppMountParameters } from "../../../src/core/public";
export class StackMonitoringPlugin {
  setup(core: CoreSetup<{ alertingDashboards?: object }>) {
    core.application.register({
      id: "stackMonitoring",
      title: "Stack Monitoring",
      order: 7000,
      category: DEFAULT_APP_CATEGORIES.management,
      async mount(params: AppMountParameters) {
        const [start, plugins] = await core.getStartServices();
        const { renderApp } = await import("./application");
        return renderApp(start, params, Boolean(plugins.alertingDashboards));
      },
    });
    return {};
  }
  start() {
    return {};
  }
  stop() {}
}
