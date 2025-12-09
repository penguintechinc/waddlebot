"""
Discord Interaction Handler - Manages modals, buttons, and component building
"""
import discord
from typing import Dict, Any, List, Optional
import json


class InteractionHandler:
    """
    Handles complex Discord interactions including:
    - Modal building and submission
    - Button view creation
    - Select menu handling
    - Interaction context storage
    """

    def __init__(self, redis_client=None):
        self.redis = redis_client
        self._context_cache: Dict[str, Any] = {}

    async def store_interaction_context(
        self,
        custom_id: str,
        context: Dict[str, Any],
        ttl: int = 900  # 15 minutes (Discord interaction token expiry)
    ):
        """Store interaction context for later retrieval"""
        if self.redis:
            await self.redis.setex(
                f"discord:interaction:{custom_id}",
                ttl,
                json.dumps(context)
            )
        else:
            self._context_cache[custom_id] = context

    async def get_interaction_context(
        self,
        custom_id: str
    ) -> Optional[Dict[str, Any]]:
        """Retrieve stored interaction context"""
        if self.redis:
            data = await self.redis.get(f"discord:interaction:{custom_id}")
            if data:
                return json.loads(data)
        return self._context_cache.get(custom_id)

    async def clear_interaction_context(self, custom_id: str):
        """Clear stored interaction context"""
        if self.redis:
            await self.redis.delete(f"discord:interaction:{custom_id}")
        elif custom_id in self._context_cache:
            del self._context_cache[custom_id]

    def build_modal(self, config: Dict[str, Any]) -> discord.ui.Modal:
        """Build a Discord Modal from configuration"""
        modal = DynamicModal(
            title=config.get('title', 'Form'),
            custom_id=config.get('custom_id', 'dynamic_modal')
        )

        for field in config.get('fields', []):
            input_text = discord.ui.InputText(
                label=field.get('label', 'Field'),
                placeholder=field.get('placeholder', ''),
                required=field.get('required', True),
                min_length=field.get('min_length'),
                max_length=field.get('max_length', 1000),
                style=self._get_input_style(field.get('style', 'short'))
            )
            modal.add_item(input_text)

        return modal

    def _get_input_style(self, style: str) -> discord.InputTextStyle:
        """Convert style string to InputTextStyle"""
        if style == 'long' or style == 'paragraph':
            return discord.InputTextStyle.long
        return discord.InputTextStyle.short

    def build_view(
        self,
        components: List[Dict[str, Any]],
        callback_handler=None,
        timeout: int = 300
    ) -> discord.ui.View:
        """Build a View with buttons and select menus"""
        view = DynamicView(
            timeout=timeout,
            callback_handler=callback_handler
        )

        for row_idx, row in enumerate(self._organize_rows(components)):
            for component in row:
                item = self._build_component(component, callback_handler)
                if item:
                    item.row = row_idx
                    view.add_item(item)

        return view

    def _organize_rows(
        self,
        components: List[Dict[str, Any]]
    ) -> List[List[Dict[str, Any]]]:
        """Organize components into rows (max 5 per row, 5 rows total)"""
        rows: List[List[Dict[str, Any]]] = [[]]
        current_row = 0

        for component in components:
            # Select menus take a full row
            if component.get('type') == 'select':
                if rows[current_row]:
                    current_row += 1
                    rows.append([])
                rows[current_row].append(component)
                current_row += 1
                rows.append([])
            else:
                # Buttons can have 5 per row
                if len(rows[current_row]) >= 5:
                    current_row += 1
                    rows.append([])
                rows[current_row].append(component)

        # Remove empty trailing rows
        while rows and not rows[-1]:
            rows.pop()

        return rows[:5]  # Max 5 rows

    def _build_component(
        self,
        config: Dict[str, Any],
        callback_handler=None
    ) -> Optional[discord.ui.Item]:
        """Build a single component from config"""
        comp_type = config.get('type')

        if comp_type == 'button':
            return self._build_button(config, callback_handler)
        elif comp_type == 'select':
            return self._build_select(config, callback_handler)
        elif comp_type == 'link_button':
            return self._build_link_button(config)

        return None

    def _build_button(
        self,
        config: Dict[str, Any],
        callback_handler=None
    ) -> discord.ui.Button:
        """Build a Button from config"""
        button = discord.ui.Button(
            style=self._get_button_style(config.get('style', 'primary')),
            label=config.get('label', 'Button'),
            custom_id=config.get('custom_id'),
            emoji=config.get('emoji'),
            disabled=config.get('disabled', False)
        )

        if callback_handler:
            async def callback(interaction: discord.Interaction):
                await callback_handler(
                    interaction,
                    'button',
                    config.get('custom_id'),
                    {}
                )
            button.callback = callback

        return button

    def _build_link_button(self, config: Dict[str, Any]) -> discord.ui.Button:
        """Build a link button (no callback needed)"""
        return discord.ui.Button(
            style=discord.ButtonStyle.link,
            label=config.get('label', 'Link'),
            url=config.get('url', 'https://example.com'),
            emoji=config.get('emoji')
        )

    def _build_select(
        self,
        config: Dict[str, Any],
        callback_handler=None
    ) -> discord.ui.Select:
        """Build a Select menu from config"""
        options = [
            discord.SelectOption(
                label=opt.get('label', 'Option'),
                value=opt.get('value', opt.get('label', 'option')),
                description=opt.get('description'),
                emoji=opt.get('emoji'),
                default=opt.get('default', False)
            )
            for opt in config.get('options', [])[:25]  # Discord limit
        ]

        select = discord.ui.Select(
            placeholder=config.get('placeholder', 'Select an option...'),
            custom_id=config.get('custom_id'),
            min_values=config.get('min_values', 1),
            max_values=config.get('max_values', 1),
            options=options,
            disabled=config.get('disabled', False)
        )

        if callback_handler:
            async def callback(interaction: discord.Interaction):
                await callback_handler(
                    interaction,
                    'select',
                    config.get('custom_id'),
                    {'values': select.values}
                )
            select.callback = callback

        return select

    def _get_button_style(self, style: str) -> discord.ButtonStyle:
        """Convert style string to ButtonStyle"""
        styles = {
            'primary': discord.ButtonStyle.primary,
            'secondary': discord.ButtonStyle.secondary,
            'success': discord.ButtonStyle.success,
            'danger': discord.ButtonStyle.danger,
            'blurple': discord.ButtonStyle.primary,
            'gray': discord.ButtonStyle.secondary,
            'grey': discord.ButtonStyle.secondary,
            'green': discord.ButtonStyle.success,
            'red': discord.ButtonStyle.danger
        }
        return styles.get(style.lower(), discord.ButtonStyle.primary)

    def build_embed(self, config: Dict[str, Any]) -> discord.Embed:
        """Build a Discord Embed from configuration"""
        # Parse color
        color = config.get('color', 0x5865F2)
        if isinstance(color, str):
            color = int(color.replace('#', ''), 16)

        embed = discord.Embed(
            title=config.get('title'),
            description=config.get('description'),
            color=discord.Color(color),
            url=config.get('url')
        )

        # Author
        if config.get('author'):
            author = config['author']
            embed.set_author(
                name=author.get('name', ''),
                url=author.get('url'),
                icon_url=author.get('icon_url')
            )

        # Thumbnail and Image
        if config.get('thumbnail'):
            embed.set_thumbnail(url=config['thumbnail'])

        if config.get('image'):
            embed.set_image(url=config['image'])

        # Fields
        for field in config.get('fields', []):
            embed.add_field(
                name=field.get('name', 'Field'),
                value=field.get('value', '\u200b'),
                inline=field.get('inline', False)
            )

        # Footer
        if config.get('footer'):
            footer = config['footer']
            if isinstance(footer, str):
                embed.set_footer(text=footer)
            else:
                embed.set_footer(
                    text=footer.get('text', ''),
                    icon_url=footer.get('icon_url')
                )

        # Timestamp
        if config.get('timestamp'):
            embed.timestamp = discord.utils.utcnow()

        return embed


class DynamicModal(discord.ui.Modal):
    """Dynamic modal that can be configured at runtime"""

    def __init__(self, title: str, custom_id: str, callback_handler=None):
        super().__init__(title=title, custom_id=custom_id)
        self.callback_handler = callback_handler

    async def callback(self, interaction: discord.Interaction):
        """Handle modal submission"""
        if self.callback_handler:
            # Extract values from all input fields
            values = {}
            for i, child in enumerate(self.children):
                if hasattr(child, 'value'):
                    values[f"field_{i}"] = child.value

            await self.callback_handler(
                interaction,
                'modal_submit',
                self.custom_id,
                {'values': values}
            )
        else:
            await interaction.response.send_message(
                "Form submitted!",
                ephemeral=True
            )


class DynamicView(discord.ui.View):
    """Dynamic view that can handle callbacks via a handler function"""

    def __init__(self, timeout: int = 300, callback_handler=None):
        super().__init__(timeout=timeout)
        self.callback_handler = callback_handler

    async def on_timeout(self):
        """Disable all components on timeout"""
        for item in self.children:
            if hasattr(item, 'disabled'):
                item.disabled = True
