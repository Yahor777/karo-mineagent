package dev.mineagent.bridge.neoforge;

import dev.mineagent.bridge.common.game.BridgeGameAccess;
import dev.mineagent.bridge.common.game.GameEntitySnapshot;
import dev.mineagent.bridge.common.game.GameVector;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;

/**
 * Реализация {@link BridgeGameAccess} поверх NeoForge 1.21.1 client API. Все
 * методы исполняются на client game thread (через {@code MainThreadQueue} →
 * {@link ClientBridgeSetup}#onClientTickStart), поэтому прямой доступ к
 * {@link Minecraft} потокобезопасен (entry-12 source-ledger).
 *
 * Summon/effects требуют server-side операций (integrated server в singleplayer
 * dev world). На чистом клиенте без integrated-server они возвращают осмысленную
 * ошибку — dev world предполагает singleplayer с открытым integrated server.
 *
 * Состав снимка get_state и формат скриншота идентичны Fabric-версии, чтобы
 * расширение получало одинаковые данные с любого loader'а.
 */
public final class NeoForgeGameAccess implements BridgeGameAccess {

    @Override
    public boolean isClientReady() {
        Minecraft mc = Minecraft.getInstance();
        return mc != null && mc.level != null && mc.player != null;
    }

    @Override
    public String summon(String entityTypeId, GameVector pos) {
        Optional<EntityType<?>> typeOpt = BuiltInRegistries.ENTITY_TYPE
                .getOptional(ResourceLocation.tryParse(entityTypeId));
        if (typeOpt.isEmpty()) {
            return "summon: unknown entity type " + entityTypeId;
        }
        ServerLevel serverLevel = serverLevel();
        if (serverLevel == null) {
            return "summon: only available in singleplayer (integrated) dev world";
        }
        LocalPlayer player = Minecraft.getInstance().player;
        Vec3 spawnAt = pos != null ? new Vec3(pos.getX(), pos.getY(), pos.getZ())
                : (player != null ? player.position().add(player.getLookAngle().scale(2)) : new Vec3(0, 0, 0));
        EntityType<?> type = typeOpt.get();
        Entity entity = type.create(serverLevel);
        if (entity == null) {
            return "summon: entity factory returned null for " + entityTypeId;
        }
        entity.moveTo(spawnAt.x, spawnAt.y, spawnAt.z, 0f, 0f);
        if (!serverLevel.addFreshEntity(entity)) {
            return "summon: serverLevel.addFreshEntity returned false (collision or rules)";
        }
        return "summoned " + entityTypeId + " at (" + spawnAt.x + ", " + spawnAt.y + ", " + spawnAt.z + ")";
    }

    @Override
    public String applyEffect(String target, String effect, int duration, int amplifier) {
        Optional<MobEffect> effectOpt = BuiltInRegistries.MOB_EFFECT
                .getOptional(ResourceLocation.tryParse(effect));
        if (effectOpt.isEmpty()) {
            return "apply_effect: unknown effect " + effect;
        }
        ServerLevel serverLevel = serverLevel();
        if (serverLevel == null) {
            return "apply_effect: only available in singleplayer (integrated) dev world";
        }
        List<LivingEntity> targets = resolveLivingTargets(serverLevel, target);
        if (targets.isEmpty()) {
            return "apply_effect: no living entities matched '" + target + "'";
        }
        MobEffectInstance template = new MobEffectInstance(effectOpt.get(), duration, amplifier);
        int applied = 0;
        for (LivingEntity le : targets) {
            if (le.addEffect(new MobEffectInstance(template))) {
                applied++;
            }
        }
        return "applied " + effect + " to " + applied + " of " + targets.size() + " matched";
    }

    @Override
    public String setCamera(GameVector pos, float yaw, float pitch) {
        LocalPlayer player = Minecraft.getInstance().player;
        if (player == null) {
            return "set_camera: no local player";
        }
        player.moveTo(pos.getX(), pos.getY(), pos.getZ(), yaw, pitch);
        return "camera set " + pos + " yaw=" + yaw + " pitch=" + pitch;
    }

    @Override
    public String screenshot() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.getMainRenderTarget() == null) {
            return null;
        }
        try {
            mc.getMainRenderTarget().bindFramebuffer(true);
            int w = mc.getWindow().getWidth();
            int h = mc.getWindow().getHeight();
            int[] pixels = mc.getMainRenderTarget().getPixels();
            if (pixels == null) {
                return null;
            }
            BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            img.setRGB(0, 0, w, h, pixels, 0, w);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            ImageIO.write(img, "png", baos);
            return Base64.getEncoder().encodeToString(baos.toByteArray());
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public List<GameEntitySnapshot> getState(String selector) {
        ClientLevel level = Minecraft.getInstance().level;
        LocalPlayer player = Minecraft.getInstance().player;
        List<GameEntitySnapshot> out = new ArrayList<>();
        if (level == null || player == null) {
            return out;
        }
        AABB box = new AABB(player.position()).inflate(30);
        for (Entity e : level.getEntities((Class<Entity>) null, box::contains)) {
            if (e == player) {
                continue;
            }
            List<String> effects = new ArrayList<>();
            if (e instanceof LivingEntity le) {
                le.getActiveEffects().forEach(inst ->
                        effects.add(inst.getEffect().getDescriptionId() + " " + inst.getAmplifier()));
            }
            out.add(new GameEntitySnapshot(
                    String.valueOf(e.getId()),
                    EntityType.getKey(e.getType()).toString(),
                    e.getName().getString(),
                    new GameVector(e.getX(), e.getY(), e.getZ()),
                    e instanceof LivingEntity le ? le.getHealth() : -1,
                    effects
            ));
        }
        return out;
    }

    @Override
    public String reloadResources() {
        Minecraft.getInstance().reloadResourcePacks();
        return "resource reload triggered";
    }

    private static ServerLevel serverLevel() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.getSingleplayerServer() == null || mc.level == null) {
            return null;
        }
        return mc.getSingleplayerServer().getLevel(mc.level.dimension());
    }

    private static List<LivingEntity> resolveLivingTargets(ServerLevel level, String target) {
        List<LivingEntity> out = new ArrayList<>();
        if ("@p".equals(target) || target.isBlank()) {
            level.players().stream().findFirst().ifPresent(p -> {
                if (p instanceof LivingEntity le) out.add(le);
            });
            return out;
        }
        for (Entity e : level.getAllEntities()) {
            if (e instanceof LivingEntity le) {
                String id = EntityType.getKey(e.getType()).toString();
                if (id.equals(target) || target.equals("*")) {
                    out.add(le);
                }
            }
        }
        return out;
    }
}
