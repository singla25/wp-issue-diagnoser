<?php

namespace Unicamp_Elementor;

use Elementor\Controls_Manager;
use Elementor\Core\Schemes\Color as Scheme_Color;

defined( 'ABSPATH' ) || exit;

class Modify_Widget_Heading extends Modify_Base {

	private static $_instance = null;

	public static function instance() {
		if ( is_null( self::$_instance ) ) {
			self::$_instance = new self();
		}

		return self::$_instance;
	}

	public function initialize() {
		add_action( 'elementor/element/heading/section_title_style/before_section_end', [
			$this,
			'before_end_section_title_style',
		] );

		add_action( 'elementor/element/heading/section_title_style/after_section_end', [
			$this,
			'section_title_style',
		] );
	}

	/**
	 * @param \Elementor\Widget_Base $element The edited element.
	 */
	public function before_end_section_title_style( $element ) {
		$element->start_injection( [
			'type' => 'control',
			'at'   => 'after',
			'of'   => 'title_color',
		] );

		$element->add_control( 'link_hover_color', [
			'label'     => esc_html__( 'Link Hover Color', 'unicamp' ),
			'type'      => Controls_Manager::COLOR,
			'scheme'    => [
				'type'  => Scheme_Color::get_type(),
				'value' => Scheme_Color::COLOR_1,
			],
			'selectors' => [
				// Stronger selector to avoid section style from overwriting.
				'{{WRAPPER}}.elementor-widget-heading .elementor-heading-title a:hover' => 'color: {{VALUE}} !important;',
			],
		] );

		$element->end_injection();
	}
}
