/**
 * /api/settings — 共用 settingsService
 *
 * maxContext 保存在 runtime-settings.json，由 start-turbo.sh 启动模型时应用；
 * appliedMaxContext 反映当前模型进程实际使用的值。
 */

import { settingsService } from "../../../services/settings";

export async function GET() {
  try {
    const snapshot = await settingsService.getSettings();
    return Response.json(snapshot);
  } catch {
    return Response.json(
      { error: "本地设置服务尚未启动" },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const result = await settingsService.updateSettings(
      body.settings ?? body ?? {},
    );
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "本地设置服务尚未启动",
      },
      { status: 503 },
    );
  }
}
