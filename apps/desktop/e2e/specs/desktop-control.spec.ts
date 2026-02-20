import { test, expect } from '../fixtures';
import { HomePage, ExecutionPage } from '../pages';
import { captureForAI } from '../utils';
import { TEST_TIMEOUTS, TEST_SCENARIOS } from '../config';

test.describe('Desktop Control Diagnostics + Recovery', () => {
  test('blocked permission -> remediation -> successful follow-up action flow', async ({ window }) => {
    const homePage = new HomePage(window);
    const executionPage = new ExecutionPage(window);

    await window.waitForLoadState('domcontentloaded');

    // 1) Failure path: trigger blocked permission flow and deny.
    await homePage.enterTask(TEST_SCENARIOS.PERMISSION.keyword);
    await homePage.submitTask();

    await window.waitForURL(/.*#\/execution.*/, { timeout: TEST_TIMEOUTS.NAVIGATION });
    await executionPage.permissionModal.waitFor({
      state: 'visible',
      timeout: TEST_TIMEOUTS.PERMISSION_MODAL,
    });

    await captureForAI(window, 'desktop-control', 'permission-blocked', [
      'Permission dialog is visible',
      'Flow is blocked until user responds',
      'Deny option is available',
    ]);

    await executionPage.denyButton.click();
    await expect(executionPage.permissionModal).not.toBeVisible({
      timeout: TEST_TIMEOUTS.NAVIGATION,
    });

    // 2) Remediation path: rerun permission flow and allow.
    const continueInput =
      window.getByTestId('execution-follow-up-input').or(
        window.getByPlaceholder('Give new instructions...')
      );
    await continueInput.fill(TEST_SCENARIOS.PERMISSION.keyword);
    await continueInput.press('Enter');

    await executionPage.permissionModal.waitFor({
      state: 'visible',
      timeout: TEST_TIMEOUTS.PERMISSION_MODAL,
    });
    await executionPage.allowButton.click();
    await expect(executionPage.permissionModal).not.toBeVisible({
      timeout: TEST_TIMEOUTS.NAVIGATION,
    });

    await captureForAI(window, 'desktop-control', 'permission-remediated', [
      'Permission was re-requested and granted',
      'Blocked state is no longer visible',
      'Execution can continue',
    ]);

    // 3) Follow-up success path: submit tool-style follow-up request.
    await continueInput.fill(TEST_SCENARIOS.WITH_TOOL.keyword);
    await continueInput.press('Enter');

    await executionPage.waitForComplete();
    await expect(executionPage.statusBadge).toBeVisible();

    const statusText = (await executionPage.statusBadge.textContent())?.toLowerCase() ?? '';
    expect(statusText).toMatch(/complete|success|done|finished/);

    await captureForAI(window, 'desktop-control', 'follow-up-success', [
      'Post-remediation follow-up completed successfully',
      'Status badge indicates completion/success',
      'No permission modal remains visible',
    ]);
  });
});
