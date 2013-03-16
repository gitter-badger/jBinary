(function (exports) {

if (typeof jDataView === 'undefined' && typeof require !== 'undefined') {
	jDataView = require('jDataView');
}

// Extend code from underscorejs (modified for fast inheritance using prototypes)
function inherit(obj) {
	if ('create' in Object) {
		obj = Object.create(obj);
	} else {
		function ClonedObject() {}
		ClonedObject.prototype = obj;
		obj = new ClonedObject();
	}
	for (var i = 1; i < arguments.length; ++i) {
		var source = arguments[i];
		for (var prop in source) {
			if (source[prop] !== undefined) {
				obj[prop] = source[prop];
			}
		}
	}
	return obj;
}

function jBinary(view, structure) {
	if (!(this instanceof arguments.callee)) {
		throw new Error("Constructor may not be called as a function");
	}
	if (!(view instanceof jDataView)) {
		view = new jDataView(view, undefined, undefined, true);
	}
	this.view = view;
	this.view.seek(0);
	this._bitShift = 0;
	this.structure = inherit(jBinary.prototype.structure, structure);
}

jBinary.Property = function (reader, writer, forceNew) {
	var property = forceNew ? function () { return reader.apply(this, arguments) } : reader;
	if (writer) {
		property.write = writer;
	}
	return property;
};

function toInt(val) {
	return val instanceof Function ? val.call(this) : val;
}

jBinary.prototype.structure = {
	string: jBinary.Property(
		function (length) { return this.view.getString(toInt.call(this, length)) },
		function (length, subString) {
			if (subString.length > length) {
				subString = subString.slice(0, length);
			} else
			if (subString.length < length) {
				subString += String.fromCharCode.apply(null, new Array(length - subString.length));
			}
			this.view.writeString(subString);
		}
	),
	array: jBinary.Property(
		function (type, length) {
			length = toInt.call(this, length);
			var results = new Array(length);
			for (var i = 0; i < length; ++i) {
				results[i] = this.parse(type);
			}
			return results;
		},
		function (type, length, values) {
			for (var i = 0; i < length; i++) {
				this.write(type, values[i]);
			}
		}
	),
	bitfield: jBinary.Property(
		function (bitSize) {
			var fieldValue = 0;

			if (this._bitShift < 0 || this._bitShift >= 8) {
				var byteShift = this._bitShift >> 3; // Math.floor(_bitShift / 8)
				this.skip(byteShift);
				this._bitShift &= 7; // _bitShift + 8 * Math.floor(_bitShift / 8)
			}
			if (this._bitShift > 0 && bitSize >= 8 - this._bitShift) {
				fieldValue = this.view.getUint8() & ~(-1 << (8 - this._bitShift));
				bitSize -= 8 - this._bitShift;
				this._bitShift = 0;
			}
			while (bitSize >= 8) {
				fieldValue = this.view.getUint8() | (fieldValue << 8);
				bitSize -= 8;
			}
			if (bitSize > 0) {
				fieldValue = ((this.view.getUint8() >>> (8 - (this._bitShift + bitSize))) & ~(-1 << bitSize)) | (fieldValue << bitSize);
				this._bitShift += bitSize - 8; // passing negative value for next pass
			}

			return fieldValue;
		},
		function (bitSize, value) {
			if (this._bitShift < 0 || this._bitShift >= 8) {
				var byteShift = this._bitShift >> 3; // Math.floor(_bitShift / 8)
				this.skip(byteShift);
				this._bitShift &= 7; // _bitShift + 8 * Math.floor(_bitShift / 8)
			}
			if (this._bitShift > 0 && bitSize >= 8 - this._bitShift) {
				var pos = this.tell();
				var byte = this.view.getUint8(pos) & (-1 << (8 - this._bitShift));
				byte |= value >>> (bitSize - (8 - this._bitShift));
				this.view.setUint8(pos, byte);
				bitSize -= 8 - this._bitShift;
				this._bitShift = 0;
			}
			while (bitSize >= 8) {
				this.view.writeUint8((value >>> (bitSize - 8)) & 0xff);
				bitSize -= 8;
			}
			if (bitSize > 0) {
				var pos = this.tell();
				var byte = this.view.getUint8(pos) & ~(~(-1 << bitSize) << (8 - (this._bitShift + bitSize)));
				byte |= (value & ~(-1 << bitSize)) << (8 - (this._bitShift + bitSize));
				this.view.setUint8(pos, byte);
				this._bitShift += bitSize - 8; // passing negative value for next pass
			}
		}
	),
	seek: function (position, block) {
		position = toInt.call(this, position);
		if (block instanceof Function) {
			var old_position = this.view.tell();
			this.view.seek(position);
			var result = block.call(this);
			this.view.seek(old_position);
			return result;
		} else {
			return this.view.seek(position);
		}
	},
	tell: function () {
		return this.view.tell();
	},
	skip: function (offset) {
		offset = toInt.call(this, offset);
		this.view.seek(this.view.tell() + offset);
		return offset;
	}
};

function conditionalMethod(method) {
	return function (predicate) {
		if (predicate instanceof Function ? predicate.call(this) : predicate) {
			return this[method].apply(this, Array.prototype.slice.call(arguments, 1));
		}
	};
}

jBinary.prototype.structure.if = jBinary.Property(
	conditionalMethod('parse'),
	conditionalMethod('write')
);

var dataTypes = [
	'Uint8',
	'Uint16',
	'Uint32',
	'Int8',
	'Int16',
	'Int32',
	'Float32',
	'Float64',
	'Char'
];

function dataMethod(method, type) {
	return function (value) {
		return this.view[method + type](value);
	};
}

for (var i = 0; i < dataTypes.length; i++) {
	var dataType = dataTypes[i];
	jBinary.prototype.structure[dataType.toLowerCase()] = jBinary.Property(
		dataMethod('get', dataType),
		dataMethod('write', dataType)
	);
}

jBinary.prototype.seek = jBinary.prototype.structure.seek;
jBinary.prototype.tell = jBinary.prototype.structure.tell;
jBinary.prototype.skip = jBinary.prototype.structure.skip;

jBinary.prototype.parse = function (structure) {
	if (typeof structure === 'number') {
		structure = ['bitfield', structure];
	}

	// f, 1, 2 means f(1, 2)
	if (structure instanceof Function) {
		return structure.apply(this, Array.prototype.slice.call(arguments, 1));
	}

	// 'int32', ... is a shortcut for ['int32', ...]
	if (typeof structure === 'string') {
		structure = Array.prototype.slice.call(arguments);
	}

	// ['string', 256] means structure['string'](256)
	if (structure instanceof Array) {
		var key = structure[0];
		if (!(key in this.structure)) {
			throw new Error("Missing structure for `" + key + "`");
		}
		return this.parse.apply(this, [this.structure[key]].concat(structure.slice(1)));
	}

	// {key: val} means {key: parse(val)}
	if (typeof structure === 'object') {
		var output = {},
			current = this.current;

		this.current = output;

		for (var key in structure) {
			var value = this.parse(structure[key]);
			// skipping undefined call results (useful for 'if' statement)
			if (value !== undefined) {
				output[key] = value;
			}
		}

		this.current = current;

		return output;
	}

	throw new Error("Unknown structure type `" + structure + "`");
};

jBinary.prototype.write = function (structure, data) {
	if (typeof structure === 'number') {
		structure = ['bitfield', structure];
	}

	// f, 1, 2, data means f(1, 2, data)
	if (structure instanceof Function) {
		(structure.write || structure).apply(this, Array.prototype.slice.call(arguments, 1));
		return;
	}

	// 'int32', ..., value is a shortcut for ['int32', ..., value]
	if (typeof structure === 'string') {
		structure = Array.prototype.slice.call(arguments);
	}

	// ['string', 256], data means structure['string'](256, data)
	if (structure instanceof Array) {
		var key = structure[0];
		if (!(key in this.structure)) {
			throw new Error("Missing structure for `" + key + "`");
		}
		this.write.apply(this, [this.structure[key]].concat(structure.slice(1)).concat([data]));
		return;
	}

	// {key: type}, {key: value} means write(type, value)
	if (typeof structure === 'object') {
		var current = this.current;

		this.current = data;

		for (var key in structure) {
			this.write(structure[key], data[key]);
		}

		this.current = current;

		return;
	}

	throw new Error("Unknown structure type `" + structure + "`");
};

jBinary.prototype.modify = function (structure, callback) {
	var data = this.seek(this.tell(), function () {
		return this.parse(structure);
	});
	var newData = callback(data);
	if (newData === undefined) {
		newData = data;
	}
	this.write(structure, newData);
	return newData;
};

if (typeof module !== 'undefined' && exports === module.exports) {
	module.exports = jBinary;
} else {
	exports.jBinary = jBinary;
}

})(this);