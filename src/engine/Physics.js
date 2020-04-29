class Physics {
	static GRAVITATIONAL_ACCELERATION_CONSTANT = 9.81;

	static computeSphereInertiaTensorMatrix(mass, radius) {
		return [
			[((2 / 5) * mass * radius) >> 1, 0, 0],
			[0, (2 / 5) * mass * Math.pow(radius, 2), 0],
			[0, 0, (2 / 5) * mass * Math.pow(radius, 2)]
		];
	}

	static computeCuboidInertiaTensorMatrix(mass, width, height, depth) {
		return [
			[(1 / 12) * mass * (height * height + depth * depth), 0, 0],
			[0, (1 / 12) * mass * (width * width + depth * depth), 0],
			[0, 0, (1 / 12) * mass * (width * width + height * height)]
		];
	}
}

module.exports = Physics;
