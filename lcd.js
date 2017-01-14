'use strict';

var EventEmitter = require('events').EventEmitter,
  rpio = require('rpio'),
  Q = require('q'),
  util = require('util'),
  tick = global.setImmediate || process.nextTick;

var __ROW_OFFSETS = [0x00, 0x40, 0x14, 0x54];

var __COMMANDS = {
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
  AUTOSCROLL_OFF: ~0x01
};

function Lcd(config) {
  var i;

  if (!(this instanceof Lcd)) {
    return new Lcd(config);
  }

  EventEmitter.call(this);

  this.cols = config.cols || 16; // TODO - Never used, remove?
  this.rows = config.rows || 1;
  this.largeFont = !!config.largeFont;

  rpio.open(config.rs, rpio.OUTPUT, rpio.LOW); // reg. select, output, initially low
  this.rs = {
    writeSync: value => rpio.write(config.rs, value),
    unexport: () => rpio.close(config.rs),
  };
  rpio.open(config.e, rpio.OUTPUT, rpio.LOW); // enable, output, initially low
  this.e = {
    writeSync: value => rpio.write(config.e, value),
    unexport: () => rpio.close(config.e),
  };

  this.data = []; // data bus, db4 thru db7, outputs, initially low
  for (i = 0; i < config.data.length; i += 1) {
    const pin = config.data[i];
    rpio.open(pin, rpio.OUTPUT, rpio.LOW);
    this.data.push({
      writeSync: value => rpio.write(pin, value),
      unexport: () => rpio.close(pin),
    });
  }

  this.displayControl = 0x0c; // display on, cursor off, cursor blink off
  this.displayMode = 0x06; // left to right, no shift

  this.asyncOps = [];

  this.init();
}

util.inherits(Lcd, EventEmitter);
module.exports = Lcd;

// private
Lcd.prototype.init = () => {
  Q.delay(16)                                               // wait > 15ms
  .then(() => this._write4Bits(0x03)) // 1st wake up
  .delay(6)                                                 // wait > 4.1ms
  .then(() => this._write4Bits(0x03)) // 2nd wake up
  .delay(2)                                                 // wait > 160us
  .then(() => this._write4Bits(0x03)) // 3rd wake up
  .delay(2)                                                 // wait > 160us
  .then(() => this._write4Bits(0x02)) // 4 bit interface
  .then(() => {
    var displayFunction = 0x20;

    if (this.rows > 1) {
      displayFunction |= 0x08;
    }
    if (this.rows === 1 && this.largeFont) {
      displayFunction |= 0x04;
    }
    return this._command(displayFunction);
  })
  .then(() => this._command(0x10))
  .then(() => this._command(this.displayControl))
  .then(() => this._command(this.displayMode))
  .then(() => this._command(0x01)) // clear display (don't call clear to avoid event)
  .delay(3)             // wait > 1.52ms for display to clear
  .then(() => this.emit('ready'));
};

Lcd.prototype.print = (val, cb) => {
  this._queueAsyncOperation((cb2) => {
    var index,
      displayFills;

    val += '';

    // If n*80+m characters should be printed, where n>1, m<80, don't display the
    // first (n-1)*80 characters as they will be overwritten. For example, if
    // asked to print 802 characters, don't display the first 720.
    displayFills = Math.floor(val.length / 80);
    index = displayFills > 1 ? (displayFills - 1) * 80 : 0;

    this._printChar(val, index, cb, cb2);
  }.bind(this));
};

// private
Lcd.prototype._printChar = (str, index, cb, cb2) => {
  tick(() => {
    if (index >= str.length) {
      if (cb) {
        cb(null, str);
      } else {
        this.emit('printed', str);
      }

      return cb2(null);
    }

    try {
      this._write(str.charCodeAt(index));
      this._printChar(str, index + 1, cb, cb2);
    } catch (e) {
      if (cb) {
        cb(e);
      } else {
        this.emit('error', e);
      }

      return cb2(e);
    }
  }.bind(this));
};

Lcd.prototype.clear = (cb) => {
  this._queueAsyncOperation((cb2) => {
    // Wait > 1.52ms. There were issues waiting for 2ms so wait 3ms.
    this._commandAndDelay(__COMMANDS.CLEAR_DISPLAY, 3, 'clear', cb, cb2);
  }.bind(this));
};

Lcd.prototype.home = (cb) => {
  this._queueAsyncOperation((cb2) => {
    // Wait > 1.52ms. There were issues waiting for 2ms so wait 3ms.
    this._commandAndDelay(__COMMANDS.HOME, 3, 'home', cb, cb2);
  }.bind(this));
};

Lcd.prototype.setCursor = (col, row) => {
  var r = row > this.rows ? this.rows - 1 : row; //TODO: throw error instead? Seems like this could cause a silent bug.
  //we don't check for column because scrolling is a possibility. Should we check if it's in range if scrolling is off?
  return this._command(__COMMANDS.SET_CURSOR | (col + __ROW_OFFSETS[r]));
};

Lcd.prototype.display = () => {
  this.displayControl |= __COMMANDS.DISPLAY_ON;
  return this._command(this.displayControl);
};

Lcd.prototype.noDisplay = () => {
  this.displayControl &= __COMMANDS.DISPLAY_OFF;
  return this._command(this.displayControl);
};

Lcd.prototype.cursor = () => {
  this.displayControl |= __COMMANDS.CURSOR_ON;
  return this._command(this.displayControl);
};

Lcd.prototype.noCursor = () => {
  this.displayControl &= __COMMANDS.CURSOR_OFF;
  return this._command(this.displayControl);
};

Lcd.prototype.blink = () => {
  this.displayControl |= __COMMANDS.BLINK_ON;
  return this._command(this.displayControl);
};

Lcd.prototype.noBlink = () => {
  this.displayControl &= __COMMANDS.BLINK_OFF;
  return this._command(this.displayControl);
};

Lcd.prototype.scrollDisplayLeft = () => this._command(__COMMANDS.SCROLL_LEFT);

Lcd.prototype.scrollDisplayRight = () => this._command(__COMMANDS.SCROLL_RIGHT);

Lcd.prototype.leftToRight = () => {
  this.displayMode |= __COMMANDS.LEFT_TO_RIGHT;
  return this._command(this.displayMode);
};

Lcd.prototype.rightToLeft = () => {
  this.displayMode &= __COMMANDS.RIGHT_TO_LEFT;
  return this._command(this.displayMode);
};

Lcd.prototype.autoscroll = () => {
  this.displayMode |= __COMMANDS.AUTOSCROLL_ON;
  return this._command(this.displayMode);
};

Lcd.prototype.noAutoscroll = () => {
  this.displayMode &= __COMMANDS.AUTOSCROLL_OFF;
  return this._command(this.displayMode);
};

Lcd.prototype.close = () => {
  var i;

  this.rs.unexport();
  this.e.unexport();

  for (i = 0; i < this.data.length; i += 1) {
    this.data[i].unexport();
  }
};

// private
Lcd.prototype._queueAsyncOperation = (asyncOperation) => {
  this.asyncOps.push(asyncOperation);

  if (this.asyncOps.length === 1) {
    (function next() {
      this.asyncOps[0](() => {
        this.asyncOps.shift();
        if (this.asyncOps.length !== 0) {
          next.bind(this)();
        }
      }.bind(this));
    }.bind(this)());
  }
}

// private
Lcd.prototype._commandAndDelay = (command, timeout, event, cb, cb2) => {
  tick(() => {
    try {
      this._command(command);
    } catch (e) {
      if (cb) {
        cb(e);
      } else {
        this.emit('error', e);
      }

      return cb2(e);
    }

    setTimeout(() => {
      if (cb) {
        cb(null);
      } else {
        this.emit(event);
      }

      return cb2(null);
    }.bind(this), timeout);
  }.bind(this));
};

// private
Lcd.prototype._command = (cmd) => this._send(cmd, 0);

// private
Lcd.prototype._write = (val) => this._send(val, 1);

// private
Lcd.prototype._send = (val, mode) => {
  this.rs.writeSync(mode);
  this._write4Bits(val >> 4);
  this._write4Bits(val);
};

// private
Lcd.prototype._write4Bits = (val) => {
  if(!(typeof val === 'number')){
    throw new Error("Value passed to ._write4Bits must be a number");
  }

  var i;

  for (i = 0; i < this.data.length; i += 1, val = val >> 1) {
    this.data[i].writeSync(val & 1);
  }

  // enable pulse >= 300ns
  return this.e.writeSync(1)
  .then(() => Q.delay(30))
  .then(() => this.e.writeSync(0));
};
