export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export class HermesError extends Error {
  constructor(code, message, httpStatus = 0) {
    super(message);
    this.name = 'HermesError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
