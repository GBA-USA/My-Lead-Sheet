import { useState } from "react";
import { qrSvg } from "./qr-svg";
import { type ScannedCode, type MyCode, parseCode, handoffFor, isLive, stopCode } from "./qr-scan";

export function CodesScreen() {
  const [myCodes, setMyCodes] = useState<MyCode[]>([
    { kind: "friend", id: "u-alex", active: true },
    { kind: "band-invite", id: "b-sonic", active: true },
    { kind: "setlist", id: "s-live-2025", active: false },
    { kind: "guest", id: "g-conf", active: true },
  ]);
  const [showQr, setShowQr] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [scanned, setScanned] = useState<ScannedCode | null>(null);

  const handleShowCode = (code: MyCode) => {
    setShowQr(code.id);
    setScanned(null);
    setPastedCode("");
  };

  const handleStop = (id: string) => {
    setMyCodes(stopCode(myCodes, id));
    setShowQr(null);
  };

  const handleScan = () => {
    const parsed = parseCode(pastedCode);
    if (parsed) {
      setScanned(parsed);
      setShowQr(null);
    } else {
      setScanned(null);
    }
  };

  const getStatusMessage = () => {
    if (showQr) {
      const code = myCodes.find((c) => c.id === showQr);
      if (!code) return "";
      return code.active ? `Show my code for ${code.kind}` : "Code stopped";
    }
    if (scanned) {
      if (isLive(myCodes, scanned)) {
        const from = scanned.from || scanned.id;
        return `${handoffFor(scanned)} ready to send to ${from}`;
      } else {
        return "This code doesn't work";
      }
    }
    return "";
  };


  return (
    <div className="codes-screen">
      <div className="codes-my-codes">
        {myCodes.map((code) => (
          <div key={code.id} className="codes-code-item">
            <button onClick={() => handleShowCode(code)}>Show my code</button>
            {showQr === code.id && code.active && (
              <div
                className="codes-qr"
                dangerouslySetInnerHTML={{
                  __html: qrSvg(JSON.stringify({ kind: code.kind, id: code.id, from: "@alex" })),
                }}
              />
            )}
            {showQr === code.id && !code.active && <div className="codes-stopped">Code stopped</div>}
            <button onClick={() => handleStop(code.id)}>Stop this code</button>
          </div>
        ))}
      </div>

      <div className="codes-scan">
        <h3>Scan</h3>
        <textarea
          className="codes-textarea"
          placeholder="Paste a code"
          value={pastedCode}
          onChange={(e) => setPastedCode(e.target.value)}
        />
        <button onClick={handleScan}>Use code</button>
        {getStatusMessage() && <div className="codes-status">{getStatusMessage()}</div>}
      </div>
    </div>
  );
}
