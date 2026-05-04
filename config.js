// 免费安全版配置
// 重点：不要把 OpenRouteService API Key 放在这里。
// API Key 放到 Cloudflare Worker 的 Secret 里。
window.APP_CONFIG = {
  // 改成你部署后的 Cloudflare Worker 地址，例如：
  // https://trip-planner-proxy.your-name.workers.dev
  WORKER_BASE_URL: "https://trip-planner-api-518.zengmingbo518.workers.dev",

  // 兼容旧版：不推荐在前端填写。保持空字符串即可。
  ORS_API_KEY: "",

  DEFAULT_CENTER: [37.3382, -121.8863], // San Jose
  DEFAULT_ZOOM: 9,
  AVERAGE_DRIVE_SPEED_MPH: 35 // Worker 没配好时，演示模式用直线距离估算
};
