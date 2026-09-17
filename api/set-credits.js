(async function () {
  var SECRET = "PASTE_YOUR_ADMIN_SECRET_HERE";

  var human = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "adminSetCredits", target: "human", amount: 1000, adminSecret: SECRET })
  }).then(function (r) { return r.json(); });
  console.log("Your credits:", human);

  var judge = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "adminSetCredits", target: "agent", agentId: "judgeborck", amount: 1000, adminSecret: SECRET })
  }).then(function (r) { return r.json(); });
  console.log("Judge Borck's credits:", judge);
})();
