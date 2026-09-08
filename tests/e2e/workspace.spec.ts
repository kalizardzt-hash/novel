import { test, expect } from '@playwright/test';
test('网页建书、人物卡、自定义字段、正文保存、历史恢复与导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: '新建作品', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('作品名称').fill('雨港 · 浏览器验收');
  await dialog.getByLabel('故事的种子').fill('修钟师在雨港追查一封来信的来源。');
  await dialog.getByRole('button', { name: '创建作品' }).click();
  await expect(page.getByRole('heading', { name: '雨港 · 浏览器验收' })).toBeVisible();
  await page.locator('nav').getByRole('button', { name: '人物与关系' }).click();
  await page.getByRole('button', { name: '新建设定' }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('沈砚');
  await page.getByLabel('欲望', { exact: true }).fill('寻找父亲');
  await page.getByLabel('自定义字段名').fill('惯用手');
  await page.getByRole('dialog').locator('.inline button').click();
  await page.getByLabel('惯用手').fill('左手');
  await page.getByRole('button', { name: '保存设定' }).click();
  await expect(page.getByRole('heading', { name: '沈砚' })).toBeVisible();
  await page.locator('nav').getByRole('button', { name: '正文写作' }).click();
  await page.getByRole('button', { name: '手写一章' }).click();
  await page.getByLabel('章节标题').fill('雨夜来信');
  await page.getByLabel('小说正文').fill('沈砚把那封信压在铜钟下面。雨声沿着屋檐落下来，他没有开灯。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('正文已保存为草稿')).toBeVisible();
  await page.getByLabel('小说正文').fill('林舟推门而入，递来一把铜钥匙。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '历史版本' }).click();
  const history = page.getByRole('dialog');
  await history.locator('summary').filter({ hasText: '第 2 版' }).click();
  await history
    .locator('details')
    .filter({ hasText: '第 2 版' })
    .getByRole('button', { name: '恢复这一版' })
    .click();
  await expect(page.getByLabel('小说正文')).toContainText('沈砚把那封信');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: '导出', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('.md');
  await page.screenshot({ path: '.novel/evidence/workspace-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('世界规则、关系图、任务队列和移动布局可操作', async ({ page }) => {
  const response = await page.request.post('/api/v1/projects', {
    data: { title: '界面验收', premise: '一座有秘密的小城' },
  });
  const project = await response.json();
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('novel-project', id), project.id);
  await page.reload();
  await page.locator('nav').getByRole('button', { name: '世界观设定' }).click();
  await page.getByRole('button', { name: '新建设定' }).click();
  await page.getByLabel('设定类型').selectOption('rule');
  await page.getByLabel('名称', { exact: true }).fill('等价交换');
  await page.getByLabel('硬限制').fill('不能复活死者');
  await page.getByRole('button', { name: '保存设定' }).click();
  await expect(page.getByRole('heading', { name: '等价交换' })).toBeVisible();
  await page.locator('nav').getByRole('button', { name: '故事蓝图' }).click();
  await page.getByRole('button', { name: '规划全书蓝图', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '创作记录' }).click();
  await expect(page.locator('.run-card').first()).toContainText('等待执行');
  await page.getByRole('button', { name: '在检查点暂停' }).click();
  await expect(page.locator('.run-card').first()).toContainText('已暂停');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('nav').getByRole('button', { name: '作品概览' }).click();
  await expect(page.getByRole('heading', { name: '作品概览' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({
    path: '.novel/evidence/workspace-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('作者调整蓝图后显式确认，并生成可编辑人物卡', async ({ page }) => {
  const { SqliteStoryStore } = await import('../../packages/infrastructure/src/store.ts');
  const { projectInputSchema, runInputSchema } = await import('../../packages/domain/src/index.ts');
  // Provider result fixture in the browser-test database; this is not model-generation evidence.
  const store = new SqliteStoryStore('.novel/e2e/novel.sqlite');
  const project = store.createProject(projectInputSchema.parse({ title: '蓝图确认验收' }));
  const run = store.createRun(project.id, runInputSchema.parse({ kind: 'blueprint' }), crypto.randomUUID());
  const queued = store.runs(project.id).find((r) => r.id === run.id)!;
  // Other UI test jobs are paused; no worker is running for this database.
  const claimed = store.claim('browser-fixture', 30000);
  expect(claimed?.id).toBe(queued.id);
  store.completeBlueprint(run.id, 'browser-fixture', {
    premise: '一封信',
    theme: '真相与保护',
    ending: '沉默',
    volumes: [{ number: 1, title: '雨港', goal: '找信', endState: '公开', promises: [] }],
    characters: [
      {
        name: '林舟',
        role: '档案员',
        desire: '保护档案',
        weakness: '恐惧',
        voice: '克制',
        arc: '作证',
        secret: '隐瞒名册',
      },
    ],
    worldRules: [],
  });
  store.close();
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('novel-project', id), project.id);
  await page.reload();
  await page.locator('nav').getByRole('button', { name: '故事蓝图' }).click();
  await page.getByRole('button', { name: '调整方案' }).click();
  await page.getByRole('dialog').getByLabel('结局方向').fill('林舟决定公开档案');
  await page.getByRole('button', { name: '保存方案' }).click();
  await expect(page.locator('.approval-card')).toContainText('林舟决定公开档案');
  const before = await (await page.request.get(`/api/v1/projects/${project.id}`)).json();
  expect(before.project.approved).toBe(false);
  await page.getByRole('button', { name: '确认并采用' }).click();
  await page.locator('nav').getByRole('button', { name: '人物与关系' }).click();
  await page.getByRole('heading', { name: '林舟' }).click();
  const secret = page.getByRole('dialog').getByLabel('秘密', { exact: true });
  await expect(secret).toHaveValue('隐瞒名册');
  await expect(secret.locator('..').locator('..').getByRole('checkbox')).toBeChecked();
});
