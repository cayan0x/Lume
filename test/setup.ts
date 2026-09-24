/**
 * 单测环境准备：把 Lume 的落盘目录指到临时目录。
 *
 * 为什么必须做（2026-09-24 加度量时发现）：诊断日志与**度量**都写 DSH_HOME / APPDATA
 * 下的真实文件。测试跑一次就往开发机的指标文件里灌一批假记录——用来判断「是不是更聪明」
 * 的数据被自己的测试污染，度量就废了。指到临时目录后，测试仍然真的落盘（能断言文件内容），
 * 只是落在别处。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "lume-test-home-"));
