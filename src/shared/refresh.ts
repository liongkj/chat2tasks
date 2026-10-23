type RefreshTicket = { epoch: number; request: number };

/** Keeps polling responses ordered while allowing a slow request to complete. */
export class RefreshGate {
  private epoch = 0;
  private nextRequest = 0;
  private lastSettledRequest = 0;

  start(): RefreshTicket {
    return { epoch: this.epoch, request: ++this.nextRequest };
  }

  accept(ticket: RefreshTicket) {
    if (ticket.epoch !== this.epoch || ticket.request < this.lastSettledRequest) return false;
    this.lastSettledRequest = ticket.request;
    return true;
  }

  invalidate() {
    this.epoch++;
  }
}
