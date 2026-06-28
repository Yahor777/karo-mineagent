package dev.mineagent.bridge.common.game;

/**
 * Неизменяемая 3D-координата. Loader-agnostic DTO: loader'ы маппят её в свои
 * Vec3/BlockPos при обращении к MC API.
 */
public final class GameVector {

    private final double x;
    private final double y;
    private final double z;

    public GameVector(double x, double y, double z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    public double getX() {
        return x;
    }

    public double getY() {
        return y;
    }

    public double getZ() {
        return z;
    }

    @Override
    public String toString() {
        return "(" + x + ", " + y + ", " + z + ")";
    }
}
