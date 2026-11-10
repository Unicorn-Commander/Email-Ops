import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import type { MailboxView } from "../../lib/mailboxApi";
import type { StandingApproval, requestStandingApproval } from "../../lib/approvalsApi";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FormData: dom.window.FormData,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Testing Library reads document during import, after the DOM is installed.
let testing: typeof import("@testing-library/react");
let StandingApprovalForm: typeof import("./StandingApprovalForm").StandingApprovalForm;
before(async () => {
  testing = await import("@testing-library/react");
  StandingApprovalForm = (await import("./StandingApprovalForm")).StandingApprovalForm;
});

const mailbox = {
  id: "mailbox-1",
  active: true,
  email_address: "sender@example.com",
} as MailboxView;
const response = { approval_url: null } as StandingApproval;

function setup() {
  const { fireEvent, render, screen } = testing;
  const submissions: Array<{ workspace: string; body: Parameters<typeof requestStandingApproval>[1] }> = [];
  let created = 0;
  render(
    <StandingApprovalForm
      workspace="workspace-1"
      mailboxes={[mailbox]}
      onCreated={() => { created += 1; }}
      submitRequest={async (workspace, body) => {
        submissions.push({ workspace, body });
        return response;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Retirement outreach" } });
  fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: "2026-12-01T12:00" } });
  return { submissions, getCreated: () => created };
}

afterEach(() => testing.cleanup());

describe("standing approval form", () => {
  it("renders and submits one rule for each of six subject/body placeholders", async () => {
    const { fireEvent, screen, waitFor } = testing;
    const { submissions, getCreated } = setup();
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Your {state_name} retirement update" },
    });
    fireEvent.change(screen.getByLabelText("Plain text template"), {
      target: { value: "Hi {first_name}, your {plan_name} plan in {state_name} has {balance} as of {date_text}. Use {token}." },
    });
    const names = ["state_name", "first_name", "plan_name", "balance", "date_text", "token"];
    assert.equal(screen.getAllByLabelText(/^Regular expression for /).length, 6);
    for (const name of names) {
      assert.ok(screen.getByLabelText(`Regular expression for ${name}`));
    }
    fireEvent.click(screen.getByRole("button", { name: "Review campaign approval" }));
    await waitFor(() => assert.equal(submissions.length, 1));
    assert.equal(submissions[0].workspace, "workspace-1");
    assert.deepEqual(Object.keys(submissions[0].body.placeholder_rules ?? {}), names);
    assert.equal(submissions[0].body.placeholder_rules?.state_name, String.raw`[^\n\r]{1,120}`);
    assert.equal(submissions[0].body.subject, "Your {state_name} retirement update");
    assert.equal(getCreated(), 1);
  });

  it("names a missing rule and prevents submission", async () => {
    const { fireEvent, screen } = testing;
    const { submissions } = setup();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Update" } });
    fireEvent.change(screen.getByLabelText("Plain text template"), {
      target: { value: "Your {state_name} update" },
    });
    fireEvent.change(screen.getByLabelText("Regular expression for state_name"), {
      target: { value: "" },
    });
    assert.match(screen.getByRole("alert").textContent ?? "", /No rule exists for placeholder state_name\./);
    assert.equal((screen.getByRole("button", { name: "Review campaign approval" }) as HTMLButtonElement).disabled, true);
    fireEvent.submit(document.querySelector("form")!);
    assert.ok(screen.getAllByRole("alert").every((alert) =>
      alert.textContent?.includes("No rule exists for placeholder state_name."),
    ));
    assert.equal(submissions.length, 0);
  });

  it("keeps the built-in rules for first_name and token", async () => {
    const { fireEvent, screen, waitFor } = testing;
    const { submissions } = setup();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.change(screen.getByLabelText("Plain text template"), {
      target: { value: "Hi {first_name}, use {token}." },
    });
    assert.equal(screen.getAllByLabelText(/^Regular expression for /).length, 2);
    fireEvent.click(screen.getByRole("button", { name: "Review campaign approval" }));
    await waitFor(() => assert.equal(submissions.length, 1));
    assert.deepEqual(submissions[0].body.placeholder_rules, {
      first_name: String.raw`[\p{L}][\p{L}' .-]{0,39}`,
      token: "[0-9a-f]{16}",
    });
  });
});
