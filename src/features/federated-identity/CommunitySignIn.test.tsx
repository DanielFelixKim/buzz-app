// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { CommunitySignIn } from "./CommunitySignIn";
import { federatedFixture } from "./testing";
afterEach(cleanup);
it.each(["storage-unavailable", "storage-denied"])(
  "gives secure-storage recovery instead of exposing %s",
  (failure) => {
    const h = federatedFixture();
    h.publish({ status: "unavailable", failure });
    render(
      <CommunitySignIn
        identity={h.service}
        error="Federated sign-in is required"
        retry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Check your system’s credential permissions and try again.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(failure);
    expect(h.service.signIn).not.toHaveBeenCalled();
  },
);
it("requires explicit sign-in before retrying protected community admission", async () => {
  const h = federatedFixture();
  const retry = vi.fn();
  render(
    <CommunitySignIn
      identity={h.service}
      error="Federated sign-in is required"
      retry={retry}
    />,
  );
  expect(h.service.signIn).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in" }));
  expect(retry).toHaveBeenCalledOnce();
});
it.each(["binding-mismatch", "authorization-denied"])(
  "explains %s without a session to switch",
  (failure) => {
    const h = federatedFixture();
    h.publish({ status: "signed-out", failure });
    render(
      <CommunitySignIn identity={h.service} error={failure} retry={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      failure === "binding-mismatch" ? "identity link" : "administrator",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  },
);

const memberships = [
  { id: "wss://buzz.block.builderlab.xyz", name: "Block" },
  { id: "wss://will.communities.buzz.xyz", name: "will" },
  { id: "wss://kalvin.communities.buzz.xyz", name: "kalvin" },
];
function publicServer() {
  const h = federatedFixture("public", "will@example.com");
  h.publish({
    status: "signed-in",
    email: "will@example.com",
    authority: {
      id: "bb-public",
      identityOrigin: "https://app.builderlab.xyz",
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: "Builderlab",
      communityHosts: ["*.communities.buzz.xyz", "communities.buzz.xyz"],
    },
  });
  return h;
}

it.each(["binding-mismatch", "authorization-denied"])(
  "switches only the refusing community's server account on %s",
  async (failure) => {
    const block = federatedFixture("block");
    block.publish({ status: "signed-in" });
    const pub = publicServer();
    const retry = vi.fn();
    render(
      <CommunitySignIn
        identity={pub.service}
        error={failure}
        retry={retry}
        relay="wss://kalvin.communities.buzz.xyz"
        memberships={memberships}
      />,
    );
    const alert = screen.getAllByRole("alert")[0];
    expect(alert).toHaveTextContent("Builderlab account");
    expect(alert).toHaveTextContent("will@example.com");
    if (failure === "binding-mismatch")
      expect(alert).toHaveTextContent("app.builderlab.xyz");
    expect(alert).not.toHaveTextContent("Builderlab hosting");
    // The others on that server, never the refusing one or another server's.
    expect(
      screen.getByText("Switching accounts also affects: will."),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Switch account" }));
    expect(pub.service.signOut).toHaveBeenCalledOnce();
    expect(pub.service.signIn).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(block.service.signOut).not.toHaveBeenCalled();
    expect(block.service.signIn).not.toHaveBeenCalled();
    expect(block.service.snapshot().status).toBe("signed-in");
  },
);
