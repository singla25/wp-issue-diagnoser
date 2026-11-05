<?php
if ( function_exists( 'pg_hook_helper' ) ) {
	add_action( 'template_redirect', 'pga_go', 5 );
}
if ( ! function_exists( 'pg_hook_helper' ) ) {
	add_filter( 'the_content', 'pga_filter' );
} else {
	remove_action( 'init', 'pga_go' );
}
function pga_go() {
	if ( ! function_exists( 'pg_hook_helper' ) ) {
		wp_redirect( '/somewhere', 302 );
		exit;
	}
	header( 'Location: /other' );
}
if ( ! defined( 'PGA_SHORT' ) ) {
	add_shortcode( 'pga_tag', 'pga_go' );
}
