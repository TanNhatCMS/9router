// Local ZCode bridge — drives the installed, logged-in ZCode app over its native
// stdio protocol (see executors/zcode.js). Model calls are made by the genuine
// ZCode runtime, so Start/Coding Plan quota works without touching the Z.ai
// HTTP gateway (whose WAF blocks non-app clients). No credentials are stored.
export default {
  id: "zcode",
  priority: 138,
  alias: "zcode",
  display: {
    name: "ZCode Start Plan",
    icon: "code",
    color: "#0EA5E9",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      text: "Serves the ZCode Start Plan (GLM-5.3 / GLM-5.3-Flash) through the locally installed ZCode app's native agent runtime. No credentials stored — the shared local ZCode profile owns auth.",
    },
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "zcode://app-server/stdio",
    format: "claude",
    noAuth: true,
  },
  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
  ],
  serviceKinds: ["llm"],
  features: {
    usage: true,
    usageApikey: true,
  },
};
