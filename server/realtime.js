'use strict';
let io = null;
module.exports = {
  setIo(instance) { io = instance; },
  emit(room, event, data) { if (io) io.to(room).emit(event, data); },
  get io() { return io; },
};
