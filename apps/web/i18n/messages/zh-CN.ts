import type { DeepPartial, Messages } from "./types";

/** Partial on purpose: missing keys fall back to English. */
export const zhCN: DeepPartial<Messages> = {
  common: {
    appName: "创意工作台",
    loading: "加载中…",
    create: "创建",
    creating: "创建中…",
    signOut: "退出登录",
    signingOut: "正在退出…",
  },
  auth: {
    login: {
      metaTitle: "登录 · 创意工作台",
      title: "登录",
      description: "登录后继续使用创意工作台。",
      submit: "登录",
      submitting: "登录中…",
      switchPrompt: "还没有账号？",
      switchLink: "立即注册",
    },
    fields: { email: "邮箱", password: "密码" },
  },
  projects: {
    title: "项目",
    create: "创建项目",
    open: "打开画布",
    nameLabel: "项目名称",
  },
};
