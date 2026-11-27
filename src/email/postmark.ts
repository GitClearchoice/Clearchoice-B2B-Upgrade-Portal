// Transactional email through Postmark (sender service@clearchoiceproducts.com; needs the Postmark
// DKIM and Return-Path DNS records on clearchoiceproducts.com). Without a token, emails are logged only.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Postmark tag, e.g. "approval-request" (shows in Postmark's activity). */
  tag?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

export class PostmarkSender implements EmailSender {
  private readonly opts: { serverToken: string; from: string; messageStream?: string; fetch?: typeof fetch };
  constructor(opts: { serverToken: string; from: string; messageStream?: string; fetch?: typeof fetch }) {
    this.opts = opts;
  }

  async send(msg: EmailMessage): Promise<void> {
    const res = await (this.opts.fetch ?? fetch)("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": this.opts.serverToken },
      body: JSON.stringify({
        From: this.opts.from,
        To: msg.to,
        Subject: msg.subject,
        HtmlBody: msg.html,
        TextBody: msg.text,
        ReplyTo: msg.replyTo,
        Tag: msg.tag,
        MessageStream: this.opts.messageStream ?? "outbound",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Postmark ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}

/** Used when POSTMARK_SERVER_TOKEN isn't set (dev/testing): writes the email to the log. */
export class LogSender implements EmailSender {
  private readonly log: (m: string) => void;
  constructor(log: (m: string) => void = console.log) {
    this.log = log;
  }
  async send(msg: EmailMessage) {
    this.log(`[email not sent: no POSTMARK_SERVER_TOKEN] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
  }
}
