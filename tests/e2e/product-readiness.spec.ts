import { expect, test } from "@playwright/test";

test("模型离线时阻止发送并提供启动入口", async ({ page }) => {
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connected: false, modelName: null }),
    });
  });
  await page.goto("/");

  const input = page.getByPlaceholder(/输入问题/);
  await expect(input).toBeDisabled();
  await expect(page.getByText("本地模型未启动，暂时不能发送。")).toBeVisible();
  await page.getByRole("button", { name: "查看启动方式" }).click();
  await expect(page.getByText(/设置|运行设置/).first()).toBeVisible();
});

test("窄屏仍可进入资料库、新建并访问历史导航", async ({ page }) => {
  test.skip(
    test.info().project.name !== "mobile-chromium",
    "仅验证移动端项目",
  );
  await page.goto("/");
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="打开导航"]',
    );
    return typeof button?.onclick === "function";
  });
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("button", { name: "关闭导航" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主要功能" })).toBeVisible();
  await expect(page.getByRole("button", { name: /新对话/ })).toBeVisible();
  await page.getByRole("button", { name: /本地资料库/ }).click();
  await expect(page.getByRole("heading", { name: /本地资料库/ })).toBeVisible();
});
