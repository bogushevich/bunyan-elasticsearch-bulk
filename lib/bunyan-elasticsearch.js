const bunyan = require('bunyan');
const {Client} = require('elasticsearch');
const moment = require('moment');
const {Writable} = require('stream');

class BunyanElasticSearch extends Writable {
    constructor(options) {
        super(options);

        this.logs = [];
        this.client = options.client || new Client({
            host: options.host,
            type: 'stream'
        });
        this.indexPattern = options.indexPattern || '[logstash-]YYYY[-]MM[-]DD';
        this.type = options.type || 'logs';

        this.limit = options.limit || 100;
        this.interval = options.interval || 5000;

        this.intervalId = null;
        this.buffer = [];
    }

    generateIndexName(entry) {
        return moment.utc(entry.time).format(this.indexPattern);
    }

    _write(chunk, encoding, callback) {
        const body = JSON.parse(chunk.toString());

        body.level = bunyan.nameFromLevel[body.level];
        body.message = body.msg;
        delete body.msg;

        const entry = {
            index: this.generateIndexName(body),
            type: this.type,
            body
        };

        this.push(entry);
        callback();
    }

    push(data) {
        const length = this.buffer.push(data);

        if (length >= this.limit) {
            this.flush();
        } else if (!this.intervalId) {
            this.resetTimer();
        }
    }

    resetTimer() {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
        }

        this.intervalId = setTimeout(() => {
            this.flush();
        }, this.interval);

        if (this.closed && typeof this.intervalId.unref === 'function') {
            this.intervalId.unref();
        }
    }

    flush() {
        this.resetTimer();

        if (this.buffer.length === 0) {
            return Promise.resolve();
        }

        const oldBuffer = this.buffer;

        this.buffer = [];
        
        return new Promise((resolve) => {
            return resolve(this.bulk(oldBuffer));
        }).catch((err) => {
            return Promise.reject(err);
        });
    }

    bulk(buffer) {
        const body = buffer.reduce((sum, value) => {
            sum.push(JSON.stringify({
                index: {
                    _index: value.index,
                    _type: value.type
                }
            }));
            sum.push(JSON.stringify(value.body));

            return sum;
        }, []);

        this.client.bulk({body}, (err, resp = {}) => { // eslint-disable-line no-unused-vars
            if (err) {
                this.emit('error', err);
            }

            if (resp.errors) {
                this.emitBulkErrors(resp);
            }
        });
    }

    emitBulkErrors(response = {}) {
        if (!Array.isArray(response.items)) {
            return;
        }

        // https://github.com/elastic/elasticsearch/issues/25156#issuecomment-307806954
        response.items.forEach((item) => {
            if (item && item.index && item.index.error) {
                this.emit('error', item.index.error);
            }
        });
    }

    close() {
        this.closed = true;
        
        return this.flush();
    }
}

module.exports = BunyanElasticSearch;
