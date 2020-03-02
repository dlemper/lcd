const rpio = require('rpio');
const { promisify } = require('util');

const wait = promisify(setTimeout);

const ROW_OFFSETS = [0x00, 0x40, 0x10, 0x50]; // TODO: make this configurable, as the original values ([0x00, 0x40, 0x14, 0x54]) weren't correct

const COMMANDS = {
  CLEAR_DISPLAY: 0x01,
  HOME: 0x02,
  SET_CURSOR: 0x80,
  DISPLAY_ON: 0x04,
  DISPLAY_OFF: ~0x04,
  CURSOR_ON: 0x02,
  CURSOR_OFF: ~0x02,
  BLINK_ON: 0x01,
  BLINK_OFF: ~0x01,
  SCROLL_LEFT: 0x18,
  SCROLL_RIGHT: 0x1c,
  LEFT_TO_RIGHT: 0x02,
  RIGHT_TO_LEFT: ~0x02,
  AUTOSCROLL_ON: 0x01,
  AUTOSCROLL_OFF: ~0x01,
};

class Lcd {
  constructor() {
    this.displayControl = 0x0c; // display on, cursor off, cursor blink off
    this.displayMode = 0x06; // left to right, no shift
  }

  async init(config) {
    this.rows = config.rows || 1;
    this.largeFont = !!config.largeFont;

    this.rs = this._configurePin(config.rs);
    this.e = this._configurePin(config.e);
    this.data = config.data.map(pin => this._configurePin(pin));

    await wait(16);              // wait > 15ms
    await this._write4Bits(0x03); // 1st wake up
    await wait(6);               // wait > 4.1ms
    await this._write4Bits(0x03); // 2nd wake up
    await wait(2);               // wait > 160us
    await this._write4Bits(0x03); // 3rd wake up
    await wait(2);               // wait > 160us
    await this._write4Bits(0x02); // 4 bit interface
    await this._send(0x20
      | ((this.rows > 1) ? 0x08 : 0x00)
      | ((this.rows === 1 && this.largeFont) ? 0x24 : 0x00));
    await this._send(0x10);
    await this._send(this.displayControl);
    await this._send(this.displayMode);
    await this.clear();             
  }

  async print(val) {
    val += '';

    // If n*80+m characters should be printed, where n>1, m<80, don't display the
    // first (n-1)*80 characters as they will be overwritten. For example, if
    // asked to print 802 characters, don't display the first 720.
    const displayFills = Math.floor(val.length / 80);
    const index = displayFills > 1
      ? (displayFills - 1) * 80
      : 0;

    for (c of val.split('')) {
      await this._send(c.charCodeAt(0), 1);
    }
  }

  async clear() {
    await this._send(COMMANDS.CLEAR_DISPLAY);
    await wait(3); // wait > 1.52ms for display to clear
  }

  async home() {
    await this._send(COMMANDS.HOME);
    await wait(3);
  }

  setCursor(col, row) {
    const r = row > this.rows
      ? this.rows - 1
      : row; //TODO: throw error instead? Seems like this could cause a silent bug.
    
    //we don't check for column because scrolling is a possibility. Should we check if it's in range if scrolling is off?
    return this._send(COMMANDS.SET_CURSOR | (col + ROW_OFFSETS[r]));
  }

  display() {
    this.displayControl |= COMMANDS.DISPLAY_ON;

    return this._send(this.displayControl);
  }

  noDisplay() {
    this.displayControl &= COMMANDS.DISPLAY_OFF;

    return this._send(this.displayControl);
  }

  cursor() {
    this.displayControl |= COMMANDS.CURSOR_ON;

    return this._send(this.displayControl);
  }

  noCursor() {
    this.displayControl &= COMMANDS.CURSOR_OFF;

    return this._send(this.displayControl);
  }

  blink() {
    this.displayControl |= COMMANDS.BLINK_ON;

    return this._send(this.displayControl);
  }

  noBlink() {
    this.displayControl &= COMMANDS.BLINK_OFF;

    return this._send(this.displayControl);
  }

  scrollDisplayLeft() {
    return this._send(COMMANDS.SCROLL_LEFT);
  }

  scrollDisplayRight() {
    return this._send(COMMANDS.SCROLL_RIGHT);
  }

  leftToRight() {
    this.displayMode |= COMMANDS.LEFT_TO_RIGHT;

    return this._send(this.displayMode);
  }

  rightToLeft() {
    this.displayMode &= COMMANDS.RIGHT_TO_LEFT;

    return this._send(this.displayMode);
  }

  autoscroll() {
    this.displayMode |= COMMANDS.AUTOSCROLL_ON;

    return this._send(this.displayMode);
  }

  noAutoscroll() {
    this.displayMode &= COMMANDS.AUTOSCROLL_OFF;

    return this._send(this.displayMode);
  }

  close() {
    this.rs.unexport();
    this.e.unexport();
    this.data.forEach(n => n.unexport());
  }

  _configurePin(pin) {
    rpio.open(pin, rpio.OUTPUT, rpio.LOW); // reg. select, output, initially low

    return {
      writeSync: value => rpio.write(pin, value),
      unexport: () => rpio.close(pin),
    };
  }

  async _send(val, mode = 0) {
    this.rs.writeSync(mode);
    await this._write4Bits(val >> 4);
    await this._write4Bits(val & 15);
  }

  async _write4Bits(val) {
    if (!(typeof val === 'number')) {
      throw new Error("Value passed to ._write4Bits must be a number");
    }

    this.data.forEach((n, idx) => n.writeSync((val >> idx) & 1));
    this.e.writeSync(1);
    await wait(1); // enable pulse >= 300ns
    this.e.writeSync(0);
  }
}

module.exports = Lcd;
