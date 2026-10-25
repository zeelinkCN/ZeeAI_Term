// 全应用共用的一个 markdown-it 实例。
//
// 为什么共用：它自带一套内部状态与缓存，每处 new 一个既浪费又会出现
// "同一个文件在两个预览里渲染结果不一样"。html=false 是安全底线（远端内容不可信）。

import MarkdownIt from "markdown-it";

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });




